#!/usr/bin/env node
import dotenv from 'dotenv';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startOfToday, endOfToday, previousDay, startOfDay, endOfDay, subDays, differenceInDays } from 'date-fns';
import { MongoClient } from 'mongodb';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Create exports directory if it doesn't exist
const exportsDir = path.join(__dirname, '../exports');
if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
}
// import "mcps-logger/console";
import { z } from "zod";
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
// Tool to fetch summary statistics
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
// Utils to render a detailed table of room history
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
// Tool to fetch cleaning photos with entry and exit times
server.registerTool("buscar_fotos", {
    title: "Buscar Fotos da Limpeza",
    description: "Busca as fotos de entrada e saída da limpeza de uma sala",
    inputSchema: {
        sala: z.string().describe("Nome da sala (ex: SALA 28 (BANHEIRO))"),
        data_inicio: z.string().describe("Data de início no formato DD/MM/YYYY").optional(),
        data_fim: z.string().describe("Data de fim no formato DD/MM/YYYY").optional()
    }
}, async ({ sala, data_inicio, data_fim }) => {
    try {
        if (!sala) {
            throw new Error('O parâmetro "sala" é obrigatório');
        }
        // Helper function to parse dates from DD/MM/YYYY format
        const parseDate = (dateStr) => {
            if (!dateStr)
                return null;
            const [day, month, year] = dateStr.split('/').map(Number);
            return new Date(year, month - 1, day);
        };
        // Use Atlas Search to find the best matching room name with fuzzy search
        const searchResults = await db.collection('items').aggregate([
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
            { $limit: 3 } // Limit to top 3 results
        ]).toArray();
        // Filter results with a minimum score to ensure relevance
        const MIN_SCORE = 0.7; // Threshold of 70%
        const validResults = searchResults.filter((result) => result.score >= MIN_SCORE);
        if (validResults.length === 0) {
            throw new Error(`Nenhuma sala encontrada que corresponda a "${sala}". Por favor, verifique o nome e tente novamente.`);
        }
        // Parse date range or default to today
        const startDate = data_inicio ? parseDate(data_inicio) : new Date();
        if (startDate)
            startDate.setHours(0, 0, 0, 0);
        const endDate = data_fim ? parseDate(data_fim) : new Date();
        if (endDate)
            endDate.setHours(23, 59, 59, 999);
        const filterByDate = Boolean(data_inicio || data_fim);
        // Process each valid result
        const results = [];
        for (const result of validResults) {
            // Find history entries within date range
            const filteredEntries = (result.history || []).filter((entry) => {
                if (!entry.date)
                    return false;
                const entryDate = new Date(entry.date);
                const isAfterStart = !startDate || entryDate >= startDate;
                const isBeforeEnd = !endDate || entryDate <= endDate;
                return isAfterStart && isBeforeEnd;
            });
            if (filteredEntries.length === 0)
                continue;
            // Sort by date descending (newest first)
            filteredEntries.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            // Get the most recent entry if available
            const latestEntry = filteredEntries[0];
            if (!latestEntry)
                continue;
            // Get RESELLER_API from environment
            const apiBaseUrl = process.env.RESELLER_API;
            if (!apiBaseUrl) {
                throw new Error('RESELLER_API não está configurado no ambiente');
            }
            // Create photo URLs
            const photos = {};
            if (latestEntry.startedPhoto) {
                photos.entrada = `${apiBaseUrl}/bin/uploads/${latestEntry.startedPhoto}`;
            }
            if (latestEntry.finishedPhoto) {
                photos.saida = `${apiBaseUrl}/bin/uploads/${latestEntry.finishedPhoto}`;
            }
            if (Object.keys(photos).length > 0) {
                results.push({
                    sala: result.name,
                    data: latestEntry.date,
                    fotos: photos
                });
            }
        }
        if (results.length === 0) {
            const dateRangeText = filterByDate
                ? `no período de ${startDate.toLocaleDateString('pt-BR')} a ${endDate.toLocaleDateString('pt-BR')}`
                : `para hoje (${new Date().toLocaleDateString('pt-BR')})`;
            return {
                content: [{
                        type: "text",
                        text: `Nenhuma foto de limpeza encontrada ${dateRangeText}`
                    }]
            };
        }
        // Format the response
        const dateRangeText = filterByDate
            ? `no período de ${startDate.toLocaleDateString('pt-BR')} a ${endDate.toLocaleDateString('pt-BR')}`
            : `para hoje (${new Date().toLocaleDateString('pt-BR')})`;
        const formattedResults = results.map(result => `Sala: ${result.sala}\n` +
            `Data: ${new Date(result.data).toLocaleString('pt-BR')}\n` +
            'Fotos:\n' +
            (result.fotos.entrada ? `- Entrada: ${result.fotos.entrada}\n` : '') +
            (result.fotos.saida ? `- Saída: ${result.fotos.saida}\n` : '') +
            'A busca retorna apenas os registros mais recentes para os dias selecionados. Se estiver procurando algo específico, indique o dia e horário desejado.').join('\n---\n');
        return {
            content: [{
                    type: "text",
                    text: `Fotos de limpeza encontradas ${dateRangeText}:\n\n${formattedResults}`
                }]
        };
    }
    catch (error) {
        console.error('Error in buscar_fotos_limpeza:', error);
        return {
            content: [{
                    type: "text",
                    text: `Erro ao buscar fotos de limpeza: ${error.message}`
                }]
        };
    }
});
// Tool to export cleaning records to Excel
server.registerTool("exportar_registros", {
    title: "Exportar Registros de Limpeza",
    description: "Exporta os registros de limpeza para um arquivo Excel",
    inputSchema: {
        sala: z.string().describe("Nome da sala (opcional, ex: SALA 28 (BANHEIRO))").optional(),
        data_inicio: z.string().describe("Data de início no formato DD/MM/YYYY").optional(),
        data_fim: z.string().describe("Data de fim no formato DD/MM/YYYY").optional(),
        dias_anteriores: z.number().int().describe("Número de dias anteriores para exportar (opcional, máximo 90 dias)").max(90).optional()
    }
}, async ({ sala, data_inicio, data_fim, dias_anteriores }) => {
    // Configurações
    const MAX_RECORDS = 50000; // Limite máximo de registros
    const MAX_DAYS = 90; // Limite máximo de dias para exportação
    const TEMP_FILE_EXPIRY = 5 * 60 * 1000; // 5 minutos para expiração do arquivo temporário
    // Função para limpar arquivos temporários antigos
    const cleanOldTempFiles = () => {
        try {
            const now = Date.now();
            const files = fs.readdirSync(exportsDir);
            files.forEach(file => {
                if (file.startsWith('limpeza_export_') && file.endsWith('.xlsx')) {
                    const filePath = path.join(exportsDir, file);
                    const stats = fs.statSync(filePath);
                    // Se o arquivo for mais antigo que TEMP_FILE_EXPIRY, deleta
                    if (now - stats.mtimeMs > TEMP_FILE_EXPIRY) {
                        fs.unlinkSync(filePath);
                    }
                }
            });
        }
        catch (error) {
            console.error('Erro ao limpar arquivos temporários:', error);
        }
    };
    // Função para validar e formatar data
    const parseAndValidateDate = (dateStr, fieldName) => {
        if (!dateStr)
            return null;
        // Verifica o formato da data
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
            throw new Error(`Formato de data inválido para ${fieldName}. Use DD/MM/YYYY`);
        }
        const [day, month, year] = dateStr.split('/').map(Number);
        const date = new Date(year, month - 1, day);
        // Verifica se a data é válida
        if (isNaN(date.getTime())) {
            throw new Error(`Data inválida para ${fieldName}: ${dateStr}`);
        }
        return date;
    };
    try {
        // Limpa arquivos temporários antigos
        cleanOldTempFiles();
        // Valida e configura o intervalo de datas
        let startDate;
        let endDate = endOfDay(new Date());
        if (dias_anteriores) {
            startDate = startOfDay(subDays(new Date(), dias_anteriores));
        }
        else if (data_inicio) {
            startDate = startOfDay(parseAndValidateDate(data_inicio, 'data_inicio') || new Date(0));
        }
        else {
            startDate = startOfDay(subDays(new Date(), 7)); // Padrão: últimos 7 dias
        }
        if (data_fim) {
            endDate = endOfDay(parseAndValidateDate(data_fim, 'data_fim') || new Date());
        }
        // Valida o intervalo de datas
        if (startDate > endDate) {
            throw new Error('A data de início não pode ser posterior à data de fim');
        }
        // Valida o período máximo de exportação
        const daysDifference = differenceInDays(endDate, startDate);
        if (daysDifference > MAX_DAYS) {
            throw new Error(`O período máximo permitido é de ${MAX_DAYS} dias`);
        }
        // Set time to start and end of day
        startDate = startOfDay(startDate);
        endDate = endOfDay(endDate);
        // console.log(`Exportando registros de ${startDate.toISOString()} a ${endDate.toISOString()}`);
        // First, search for matching rooms using the same mechanism as buscar_fotos
        let searchQuery = {};
        if (sala) {
            searchQuery = {
                $search: {
                    index: "default_1",
                    text: {
                        query: sala,
                        path: "name"
                    },
                    scoreDetails: true
                }
            };
        }
        // Get matching items with their basic info first
        const searchResults = await db.collection('items').aggregate([
            ...(sala ? [searchQuery] : [{ $match: {} }]),
            {
                $project: {
                    _id: 1,
                    name: 1,
                    code: 1,
                    areaType: 1,
                    score: { $meta: "searchScore" }
                }
            },
            { $limit: 100 } // Limit to 100 results to prevent performance issues
        ]).toArray();
        // Filter by minimum score if we did a text search
        const MIN_SCORE = 0.7;
        const validItems = sala
            ? searchResults.filter((item) => item.score >= MIN_SCORE)
            : searchResults;
        if (validItems.length === 0) {
            throw new Error('Nenhuma sala encontrada com os critérios fornecidos');
        }
        // Get the item IDs for the second query
        const itemIds = validItems.map((item) => item._id);
        // Usando cursor para processar os itens em lotes
        const itemsCursor = db.collection('items').aggregate([
            {
                $match: {
                    _id: { $in: itemIds },
                    'history.date': { $gte: startDate, $lte: endDate }
                }
            },
            {
                $project: {
                    name: 1,
                    code: 1,
                    areaType: 1,
                    history: {
                        $filter: {
                            input: '$history',
                            as: 'h',
                            cond: {
                                $and: [
                                    { $gte: ['$$h.date', startDate] },
                                    { $lte: ['$$h.date', endDate] }
                                ]
                            }
                        }
                    }
                }
            }
        ], { allowDiskUse: true, batchSize: 100 });
        // Processa os itens em lotes
        const items = [];
        let totalEntries = 0;
        let shouldContinue = true;
        while (await itemsCursor.hasNext() && shouldContinue) {
            const item = await itemsCursor.next();
            if (!item || !item.history || item.history.length === 0)
                continue;
            // Ordena o histórico por data (mais recente primeiro)
            const sortedHistory = [...item.history].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            items.push({
                ...item,
                history: sortedHistory
            });
            // Verifica se atingiu o limite de registros
            totalEntries += sortedHistory.length;
            if (totalEntries > MAX_RECORDS) {
                shouldContinue = false;
                break;
            }
        }
        if (!items || items.length === 0) {
            return {
                content: [{
                        type: 'text',
                        text: 'Nenhum registro encontrado para o período selecionado.'
                    }]
            };
        }
        // console.log(`Encontrados ${items.length} itens com histórico`);
        // Verifica se atingiu o limite de registros
        if (totalEntries > MAX_RECORDS) {
            return {
                content: [{
                        type: 'text',
                        text: `Limite de ${MAX_RECORDS.toLocaleString('pt-BR')} registros excedido. Por favor, reduza o intervalo de datas.`
                    }]
            };
        }
        // Cria um stream para escrita do arquivo Excel
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
            .replace('T', '_').split('Z')[0];
        const fileName = `limpeza_export_${timestamp}.xlsx`;
        const filePath = path.join(exportsDir, fileName);
        // Cria o diretório de exportação se não existir
        if (!fs.existsSync(exportsDir)) {
            fs.mkdirSync(exportsDir, { recursive: true });
        }
        // Cria o workbook e worksheet
        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet([]);
        // Adiciona cabeçalhos
        const headers = [
            'Local', 'Código', 'Área', 'Data', 'Início', 'Fim',
            'Papel Toalha', 'Papel Higiênico', 'Sabão', 'Sanitizante',
            'Concorrente', 'Terminal', 'Criado por', 'Observações'
        ];
        // Adiciona os dados em lotes para evitar sobrecarga de memória
        const BATCH_SIZE = 1000;
        let batch = [];
        let processedEntries = 0;
        // Função para processar um lote de dados
        const processBatch = (batchData) => {
            XLSX.utils.sheet_add_json(worksheet, batchData, {
                header: headers,
                skipHeader: true,
                origin: -1 // Adiciona após os dados existentes
            });
            // Atualiza o arquivo em disco periodicamente
            XLSX.utils.book_append_sheet(workbook, worksheet, 'Histórico de Limpeza', true);
            XLSX.writeFile(workbook, filePath);
        };
        // Processa cada item e seu histórico
        for (const item of items) {
            if (!item.history || item.history.length === 0)
                continue;
            for (const entry of item.history) {
                try {
                    batch.push({
                        'Local': item.name || 'Sem nome',
                        'Código': item.code || 'Sem código',
                        'Área': item.areaType === 'critica' ? 'Crítica' :
                            item.areaType === 'semicritica' ? 'Semicrítica' :
                                item.areaType === 'naocritica' ? 'Não Crítica' : 'Não Especificada',
                        'Data': entry.date ? new Date(entry.date).toLocaleString('pt-BR') : 'N/A',
                        'Início': entry.startTime || 'N/A',
                        'Fim': entry.endTime || 'N/A',
                        'Papel Toalha': entry.paperTowel ? 'Sim' : 'Não',
                        'Papel Higiênico': entry.toiletPaper ? 'Sim' : 'Não',
                        'Sabão': entry.soap ? 'Sim' : 'Não',
                        'Sanitizante': entry.handSanitizer ? 'Sim' : 'Não',
                        'Concorrente': entry.concurrent ? 'Sim' : 'Não',
                        'Terminal': entry.terminal ? 'Sim' : 'Não',
                        'Criado por': entry.createdBy || 'Desconhecido',
                        'Observações': entry.observations || ''
                    });
                    processedEntries++;
                    // Processa o lote quando atinge o tamanho máximo
                    if (batch.length >= BATCH_SIZE) {
                        processBatch(batch);
                        batch = [];
                    }
                }
                catch (err) {
                    console.error('Erro ao processar entrada:', err);
                }
            }
        }
        // Processa o último lote, se houver
        if (batch.length > 0) {
            processBatch(batch);
        }
        if (processedEntries === 0) {
            return {
                content: [{
                        type: 'text',
                        text: 'Nenhum dado disponível para exportação após filtragem.'
                    }]
            };
        }
        // console.log(`Exportando ${processedEntries.toLocaleString('pt-BR')} registros para Excel`);
        // Configura o tamanho das colunas
        const columnWidths = [
            { wch: 30 }, // Local
            { wch: 15 }, // Código
            { wch: 15 }, // Área
            { wch: 20 }, // Data
            { wch: 10 }, // Início
            { wch: 10 }, // Fim
            { wch: 12 }, // Papel Toalha
            { wch: 15 }, // Papel Higiênico
            { wch: 10 }, // Sabão
            { wch: 15 }, // Sanitizante
            { wch: 12 }, // Concorrente
            { wch: 10 }, // Terminal
            { wch: 25 }, // Criado por
            { wch: 50 } // Observações
        ];
        // Aplica os tamanhos das colunas
        worksheet['!cols'] = columnWidths;
        // Adiciona os cabeçalhos
        const headerRow = XLSX.utils.aoa_to_sheet([headers]);
        XLSX.utils.sheet_add_aoa(worksheet, [headers], { origin: 'A1' });
        // Salva o arquivo final
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Histórico de Limpeza', true);
        XLSX.writeFile(workbook, filePath);
        // console.log(`Arquivo exportado com sucesso: ${filePath}`);
        // Lê o arquivo como base64 para download
        const fileData = fs.readFileSync(filePath, { encoding: 'base64' });
        // Agenda a limpeza do arquivo temporário após o download
        setTimeout(() => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    // console.log(`Arquivo temporário removido: ${filePath}`);
                }
            }
            catch (error) {
                console.error('Erro ao remover arquivo temporário:', error);
            }
        }, TEMP_FILE_EXPIRY);
        // Return file download information in MCP format
        return {
            content: [{
                    type: 'text',
                    text: `Exportação concluída: ${totalEntries} registros exportados.\n` +
                        `Período: ${startDate.toLocaleDateString('pt-BR')} a ${endDate.toLocaleDateString('pt-BR')}\n` +
                        `Arquivo: ${fileName}\n\n` +
                        'O arquivo está disponível para download abaixo:'
                }, {
                    type: 'resource',
                    resource: {
                        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        uri: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${fileData}`,
                        text: `Baixar ${fileName}`
                    }
                }]
        };
    }
    catch (error) {
        console.error('Erro ao exportar registros:', error);
        return {
            content: [{
                    type: 'text',
                    text: `Erro ao exportar registros: ${error.message}`
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
