#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startOfToday, endOfToday, previousDay } from 'date-fns';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { rooms } from "./roomList";
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
        logging: {},
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
    const headers = ['Tempo', 'Suprimentos', 'Observações', 'Data', 'Criado por'];
    const head = `
    <tr>
      ${headers.map(h => `<th style="padding:8px;border:1px solid #ddd;background-color:#f5f5f5;text-align:left">${h}</th>`).join('')}
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
        return `
      <tr>
        <td style="padding:8px;border:1px solid #ddd;vertical-align:top">${timeCell}</td>
        <td style="padding:8px;border:1px solid #ddd;vertical-align:top">${suppliesCell}</td>
        <td style="padding:8px;border:1px solid #ddd;vertical-align:top">${observationsCell}</td>
        <td style="padding:8px;border:1px solid #ddd;vertical-align:top">${formattedDate}</td>
        <td style="padding:8px;border:1px solid #ddd;vertical-align:top">${createdBy}</td>
      </tr>
    `;
    }).join('');
    return `
    <div style="font-family: Arial, sans-serif; font-size: 14px;">
      <table style="border-collapse: collapse; width: 100%;">
        <thead>${head}</thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}
// Resource to view all records for a specific room
server.registerResource("registros_completos_por_sala", new ResourceTemplate("unimed://registros_completos_por_sala/{sala}?data_inicio={data_inicio}&data_fim={data_fim}", {
    list: async () => ({
        resources: rooms.map(sala => {
            const encodedSala = encodeURIComponent(sala);
            return {
                name: sala,
                title: `Todos registros: ${sala}`,
                description: `Visualizar todos os registros da sala ${sala}`,
                uri: `unimed://registros_completos_por_sala/${encodedSala}`
            };
        })
    })
}), {
    title: "Registros completos por sala",
    description: "Exibe todos os registros de uma sala em uma única tabela"
}, async (uri, { sala, data_inicio, data_fim, usuario }) => {
    try {
        if (!sala) {
            throw new Error('O parâmetro "sala" é obrigatório');
        }
        const roomParam = Array.isArray(sala) ? decodeURIComponent(sala[0]) : decodeURIComponent(sala);
        if (!rooms.includes(roomParam)) {
            throw new Error(`Sala "${roomParam}" não encontrada`);
        }
        const roomName = rooms.find(r => r === roomParam || encodeURIComponent(r) === encodeURIComponent(roomParam));
        if (!roomName)
            throw new Error("Sala inválida.");
        // Fetch room history
        const room = await db.collection("items").findOne({ name: roomName });
        let history = [...(room?.history || [])];
        // Filter by date if provided
        if (data_inicio || data_fim) {
            // Parse dates from dd/MM/yyyy format
            const parseDate = (dateStr) => {
                if (!dateStr)
                    return null;
                // First decode URI component to handle %2F
                const decoded = decodeURIComponent(dateStr);
                const [day, month, year] = decoded.split('/').map(Number);
                return new Date(year, month - 1, day);
            };
            const startDate = data_inicio
                ? parseDate(Array.isArray(data_inicio) ? data_inicio[0] : data_inicio)
                : new Date(0);
            let endDate = data_fim
                ? parseDate(Array.isArray(data_fim) ? data_fim[0] : data_fim)
                : new Date();
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
        // Enrich with user email
        for (const entry of history) {
            if (entry.createdBy) {
                const u = await db.collection('users').findOne({ _id: entry.createdBy }, { projection: { email: 1 } });
                if (u)
                    entry.usuarioEmail = u.email;
            }
        }
        const html = toHtmlTable(history);
        return { contents: [{ uri: uri.href, mimeType: "text/html", text: html }] };
    }
    catch (error) {
        return { contents: [{ uri: uri.href, text: `Erro: ${error.message}` }] };
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
