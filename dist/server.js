#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startOfToday, endOfToday, previousDay } from 'date-fns';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
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
    name: "resumo-salas",
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
server.registerTool("obterResumoSalas", {
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
