#!/usr/bin/env node
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startOfToday, endOfToday, previousDay } from 'date-fns';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { salas } from "./salasList";
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
    version: "1.0.0"
});
// Connect to MongoDB
let db;
try {
    await client.connect();
    console.log('Connected to MongoDB');
    db = client.db();
}
catch (error) {
    console.error('Error connecting to MongoDB:', error);
    process.exit(1);
}
// Summary statistics tool
server.registerTool("obterResumo", {
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
function toHtmlTable(rows) {
    const header = ['Criado', 'Atualizado', 'Colaborador', 'Área'];
    const head = header.map(h => `<th style="padding:4px;border:1px solid #ccc">${h}</th>`).join('');
    const body = rows.map(r => `
    <tr>
      <td style="padding:4px;border:1px solid #ccc">${r.createdAt}</td>
      <td style="padding:4px;border:1px solid #ccc">${r.updatedAt}</td>
      <td style="padding:4px;border:1px solid #ccc">${r.userEmail ?? '-'}</td>
      <td style="padding:4px;border:1px solid #ccc">${r.areaType ?? '-'}</td>
    </tr>
  `).join('');
    return `<table style="border-collapse:collapse;width:100%;font-family:sans-serif">
            <thead><tr>${head}</tr></thead>
            <tbody>${body}</tbody>
          </table>`;
}
// Resource to get records for a specific room
server.registerResource("obterRegistros", new ResourceTemplate("obterRegistros://{sala}?data_inicio={data_inicio}&data_fim={data_fim}", {
    list: async () => ({
        resources: salas.map(sala => ({
            name: sala,
            title: `Registros de limpeza: ${sala}`,
            description: `Registros da sala: ${sala}`,
            uri: `obterRegistros://${sala}`
        }))
    })
}), {
    title: "Registros de salas",
    description: "Busca registros de limpeza de uma sala com intervalo de datas e paginação"
}, async (uri, { sala, data_inicio, data_fim, page = '1', limit = '10', usuario }) => {
    try {
        // Convert parameters to the correct types
        const roomParam = Array.isArray(sala) ? sala[0] : sala;
        const roomName = salas.includes(roomParam) ? roomParam : null;
        if (!roomName)
            throw new Error("Sala inválida.");
        // Parse and validate pagination parameters
        const pageNum = Math.max(1, parseInt(Array.isArray(page) ? page[0] : page) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(Array.isArray(limit) ? limit[0] : limit) || 10));
        // Get the room data
        const room = await db.collection("items").findOne({ name: roomName });
        if (!room) {
            return {
                registros: [],
                paginacao: {
                    total: 0,
                    pagina: pageNum,
                    itensPorPagina: limitNum,
                    totalPaginas: 0
                }
            };
        }
        // Filter history by date range if provided
        let filteredHistory = [...(room.history || [])];
        if (data_inicio || data_fim) {
            const startDate = data_inicio ? new Date(Array.isArray(data_inicio) ? data_inicio[0] : data_inicio) : new Date(0);
            let endDate = data_fim ? new Date(Array.isArray(data_fim) ? data_fim[0] : data_fim) : new Date();
            // Set end date to end of the day
            if (data_fim) {
                endDate.setHours(23, 59, 59, 999);
            }
            filteredHistory = filteredHistory.filter(entry => {
                const entryDate = new Date(entry.date);
                return entryDate >= startDate && entryDate <= endDate;
            });
        }
        // Sort history by date in descending order (newest first)
        filteredHistory.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        // Get total count before pagination
        const totalEntries = filteredHistory.length;
        // Apply pagination
        const startIndex = (pageNum - 1) * limitNum;
        const endIndex = pageNum * limitNum;
        const paginatedHistory = filteredHistory.slice(startIndex, endIndex);
        // Add user info to each history entry
        for (const entry of paginatedHistory) {
            if (entry.createdBy) {
                const user = await db.collection('users').findOne({ _id: entry.createdBy }, { projection: { email: 1 } });
                if (user) {
                    entry.userEmail = user.email;
                }
            }
        }
        // Format the response
        const html = toHtmlTable(paginatedHistory);
        return {
            registros: paginatedHistory,
            paginacao: {
                total: totalEntries,
                pagina: pageNum,
                itensPorPagina: limitNum,
                totalPaginas: Math.ceil(totalEntries / limitNum)
            },
            contents: [
                {
                    uri: `obterRegistros://${roomName}/${pageNum}`,
                    mimeType: "text/html",
                    text: html
                }
            ]
        };
    }
    catch (error) {
        console.error('Error in obterRegistros:', error);
        return {
            registros: [],
            paginacao: {
                total: 0,
                pagina: 1,
                itensPorPagina: 10,
                totalPaginas: 0
            },
            error: 'Erro ao buscar registros'
        };
    }
});
// Handle shutdown gracefully
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    try {
        await client.close();
        console.log('MongoDB connection closed');
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
    console.log('Server is running and connected to MongoDB');
}
catch (error) {
    console.error('Failed to start server:', error);
    await client.close();
    process.exit(1);
}
