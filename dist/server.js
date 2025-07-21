#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { startOfToday, endOfToday, previousDay } from 'date-fns';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
// import "mcps-logger/console";
// Load environment variables
dotenv.config();
// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('Error: MONGODB_URI is not defined in environment variables');
    process.exit(1);
}
// Create a new MongoClient
const client = new MongoClient(MONGODB_URI);
// Create an MCP server
const server = new McpServer({
    name: "unimed",
    version: "1.0.0",
    capabilities: {
        tools: {},
        resources: {},
    },
});
// Connect to MongoDB
let db;
try {
    await client.connect();
    db = client.db();
}
catch (error) {
    console.error('Error connecting to MongoDB:', error);
    process.exit(1);
}
// Tool to list all rooms without qrCode field
server.registerTool("listar_salas", {
    title: "Listar todas as salas",
    description: "Retorna uma lista de todas as salas cadastradas, sem o campo qrCode",
    inputSchema: {}
}, async () => {
    try {
        const rooms = await db.collection("items").find({}, { projection: { qrCode: 0 } } // Remove qrCode field
        ).toArray();
        // Group rooms by category (using text between parentheses as category)
        const roomsByCategory = {};
        rooms.forEach((room) => {
            const match = room.name.match(/(.*?)(?:\((.*?)\))?$/);
            const nameBase = (match?.[1] || room.name).trim();
            const category = match?.[2] || 'Outros';
            if (!roomsByCategory[category]) {
                roomsByCategory[category] = [];
            }
            roomsByCategory[category].push(nameBase);
        });
        // Create a summary string
        let output = `Total de salas: ${rooms.length}\n\n`;
        for (const [category, names] of Object.entries(roomsByCategory)) {
            const uniqueNames = [...new Set(names)]; // Remove duplicates
            output += `\n${category} (${uniqueNames.length}): ${uniqueNames.join(', ')}`;
        }
        return {
            content: [{ type: "text", text: output }]
        };
    }
    catch (error) {
        console.error('Error fetching rooms:', error);
        return {
            content: [{
                    type: "text",
                    text: `Erro ao buscar salas: ${error.message}`
                }]
        };
    }
});
// Summary statistics tool
server.registerTool("resumo_geral", {
    title: "Resumo das salas",
    description: "Obter estatísticas resumidas sobre as limpezas de hoje",
    inputSchema: {}
}, async () => {
    try {
        // Fetch items from MongoDB
        const items = await db.collection('items').find({}).toArray();
        if (!items || items.length === 0) {
            return { content: [{ type: "text", text: 'Nenhuma sala encontrada no banco de dados' }] };
        }
        const todayStart = startOfToday();
        const lastWeekendStart = previousDay(new Date(), 6);
        const todayEnd = endOfToday();
        let totalRooms = 0;
        let withRecords = 0;
        for (const item of items) {
            totalRooms++;
            // Check if item has any records today
            const hasRecordToday = item.history.some(record => {
                const recordDate = new Date(record.date);
                return recordDate >= todayStart && recordDate <= todayEnd;
            });
            if (hasRecordToday)
                withRecords++;
        }
        const withoutRecords = totalRooms - withRecords || 0;
        // Format the result
        const result = `Total de Salas: ${totalRooms}\nCom Registros Hoje: ${withRecords}\nSem Registros Hoje: ${withoutRecords}`;
        return { content: [{ type: "text", text: result }] };
    }
    catch (err) {
        console.error('Error in getTodaySummary:', err);
        return { content: [{ type: "text", text: 'Erro ao gerar resumo do dia' }] };
    }
});
// Render a detailed table of room history
function toHtmlTable(rows) {
    const headers = ['Sala', 'Tempo', 'Suprimentos', 'Observações', 'Data', 'Criado por'];
    const head = `
    <tr>
      ${headers.map(h => `<th>${h}</th>`).join('')}
    </tr>
  `;
    const body = rows.map(entry => {
        const entryDate = new Date(entry.date);
        const formattedDate = entryDate.toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        const timeCell = `
      <div style="margin-bottom:4px">Início: ${entry.startTime || 'N/A'}</div>
      <div>Fim: ${entry.endTime || 'N/A'}</div>
    `;
        const suppliesCell = `
      <div>Papel Toalha: ${entry.paperTowel ? '✔' : '✖'}</div>
      <div>Papel Higiênico: ${entry.toiletPaper ? '✔' : '✖'}</div>
      <div>Sabão: ${entry.soap ? '✔' : '✖'}</div>
      <div>Sanitizante: ${entry.handSanitizer ? '✔' : '✖'}</div>
    `;
        const observationsCell = entry.observations || 'Nenhuma observação';
        const createdBy = entry.usuarioEmail || 'N/A';
        const roomName = entry.roomName || entry.name || 'N/A';
        return `
      <tr>
        <td>${roomName}</td>
        <td>${timeCell}</td>
        <td>${suppliesCell}</td>
        <td>${observationsCell}</td>
        <td>${formattedDate}</td>
        <td>${createdBy}</td>
      </tr>
    `;
    }).join('');
    return `
    <table>
      <thead>${head}</thead>
      <tbody>${body}</tbody>
    </table>
  `;
}
// Tool to view all records for a specific room
server.registerTool("limpezas_feitas", {
    title: "Registros completos por sala",
    description: "Exibe todos os registros de uma sala em uma única tabela",
    inputSchema: {
        sala: z.string().describe("Nome da sala (ex: SALA 28 (BANHEIRO))"),
        data_inicio: z.string().describe("Data de início no formato DD/MM/YYYY").optional(),
        data_fim: z.string().describe("Data de fim no formato DD/MM/YYYY").optional()
    }
}, async ({ sala, data_inicio, data_fim }) => {
    if (!sala) {
        throw new Error('O parâmetro "sala" é obrigatório');
    }
    try {
        // Use Atlas Search to find the best matching room name with fuzzy search
        const searchResults = await db.collection("items").aggregate([
            {
                $search: {
                    index: "default_1",
                    text: {
                        query: sala,
                        path: "name"
                    },
                    scoreDetails: true
                }
            },
            {
                $project: {
                    _id: 1,
                    name: 1,
                    history: 1,
                    score: { $meta: "searchScore" },
                }
            },
            { $limit: 3 }
        ]).toArray();
        // Filter results with a minimum score to ensure relevance
        const MIN_SCORE = 0.7; // Threshold of 70%
        const validResults = searchResults.filter((result) => result.score >= MIN_SCORE);
        if (validResults.length === 0) {
            throw new Error(`Nenhuma sala encontrada que corresponda a "${sala}". Por favor, verifique o nome e tente novamente.`);
        }
        // Get all valid matches and their history
        const twelveHoursAgo = new Date();
        twelveHoursAgo.setHours(twelveHoursAgo.getHours() - 12);
        // Combine history from all valid results
        let combinedHistory = [];
        for (const result of validResults) {
            const roomHistory = [...(result.history || [])]
                .filter(entry => {
                const entryDate = new Date(entry.timestamp);
                // Add room name to each history entry for reference
                entry.roomName = result.name;
                return (!data_inicio && !data_fim) ? entryDate >= twelveHoursAgo : true;
            });
            combinedHistory = [...combinedHistory, ...roomHistory];
        }
        // Sort by date descending (newest first)
        combinedHistory.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        let history = combinedHistory;
        // Filter by date if provided
        if (data_inicio || data_fim) {
            // Parse dates from dd/MM/yyyy format
            const parseDate = (dateStr) => {
                if (!dateStr)
                    return null;
                const [day, month, year] = dateStr.split('/').map(Number);
                return new Date(year, month - 1, day);
            };
            const startDate = parseDate(data_inicio) || new Date(0);
            const endDate = parseDate(data_fim) || new Date();
            if (endDate) {
                endDate.setHours(23, 59, 59, 999);
            }
            history = history.filter(entry => {
                const entryDate = new Date(entry.date);
                return (!startDate || entryDate >= startDate) &&
                    (!endDate || entryDate <= endDate);
            });
        }
        // Sort by date descending
        history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        // Enrich with user email and room name
        for (const entry of history) {
            if (entry.createdBy) {
                const user = await db.collection('users').findOne({ _id: entry.createdBy }, { projection: { email: 1 } });
                if (user) {
                    entry.usuarioEmail = user.email;
                }
            }
            // Room name is already added during the history combination phase
        }
        const table = toHtmlTable(history);
        const artifact = `
        :::artifact{identifier="registros-${encodeURIComponent(sala)}"
                    type="text/html"
                    title="Registros completos – ${sala}"}
        \`\`\`
        ${table}
        \`\`\`
        :::
        `.trim();
        return {
            content: [
                { type: "text", text: artifact }
            ]
        };
    }
    catch (error) {
        console.error('Error in registros_completos_por_sala:', error);
        return {
            content: [{
                    type: "text",
                    text: `Erro ao buscar registros: ${error.message}`
                }]
        };
    }
});
// Handle shutdown gracefully
process.on('SIGINT', async () => {
    try {
        await client.close();
        process.exit(0);
    }
    catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});
// Start receiving messages on stdin and sending messages on stdout
try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
catch (error) {
    console.error('Failed to start server:', error);
    await client.close();
    process.exit(1);
}
