#!/usr/bin/env node

import dotenv from 'dotenv';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startOfToday, endOfToday, previousDay, startOfDay, endOfDay, subDays } from 'date-fns';
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
    tools: {
    },
    resources: {
    },
  },
});

// Connect to MongoDB
let db;
try {
  await client.connect();
  db = client.db();
} catch (error) {
  console.error('Error connecting to MongoDB:', error);
  process.exit(1);
}

// Tool to list all rooms without qrCode field
server.registerTool(
  "listar_salas",
  {
    title: "Listar todas as salas",
    description: "Retorna uma lista de todas as salas cadastradas, sem o campo qrCode",
    inputSchema: {}
  },
  async () => {
    try {
      const rooms = await db.collection("items").find(
        {},
        { projection: { qrCode: 0 } } // Remove qrCode field
      ).toArray();

      // Group rooms by category (using text between parentheses as category)
      const roomsByCategory: Record<string, string[]> = {};
      
      rooms.forEach((room: any) => {
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
    } catch (error) {
      console.error('Error fetching rooms:', error);
      return {
        content: [{
          type: "text",
          text: `Erro ao buscar salas: ${error.message}`
        }]
      };
    }
  }
);

// Tool to fetch summary statistics
server.registerTool("resumo_geral",
  {
    title: "Resumo das salas",
    description: "Obter estatísticas resumidas sobre as limpezas de hoje",
    inputSchema: {}
  },
  async () => {
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

        if (hasRecordToday) withRecords++;
      }

      const withoutRecords = totalRooms - withRecords || 0;

      // Format the result
      const result = `Total de Salas: ${totalRooms}\nCom Registros Hoje: ${withRecords}\nSem Registros Hoje: ${withoutRecords}`;

      return { content: [{ type: "text", text: result }] };
    } catch (err) {
      console.error('Error in getTodaySummary:', err);
      return { content: [{ type: "text", text: 'Erro ao gerar resumo do dia' }] };
    }
  }
);

// Utils to render a detailed table of room history
function toHtmlTable(rows: any[]) {
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
server.registerTool(
  "limpezas_feitas",
  {
    title: "Registros completos por sala",
    description: "Exibe todos os registros de uma sala em uma única tabela",
    inputSchema: {
      sala: z.string().describe("Nome da sala (ex: SALA 28 (BANHEIRO))"),
      data_inicio: z.string().describe("Data de início no formato DD/MM/YYYY").optional(),
      data_fim: z.string().describe("Data de fim no formato DD/MM/YYYY").optional()
    }
  },
  async ({ sala, data_inicio, data_fim }) => {
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
      const validResults = searchResults.filter((result: any) => 
        result.score >= MIN_SCORE
      );

      if (validResults.length === 0) {
        throw new Error(`Nenhuma sala encontrada que corresponda a "${sala}". Por favor, verifique o nome e tente novamente.`);
      }

      // Get all valid matches and their history
      const twelveHoursAgo = new Date();
      twelveHoursAgo.setHours(twelveHoursAgo.getHours() - 12);
      
      // Combine history from all valid results
      let combinedHistory: any[] = [];
      
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
        const parseDate = (dateStr: string) => {
          if (!dateStr) return null;
          const [day, month, year] = dateStr.split('/').map(Number);
          return new Date(year, month - 1, day);
        };

        const startDate = parseDate(data_inicio as string) || new Date(0);
        const endDate = parseDate(data_fim as string) || new Date();

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
          const user = await db.collection('users').findOne(
            { _id: entry.createdBy },
            { projection: { email: 1 } }
          );
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
    } catch (error) {
      console.error('Error in registros_completos_por_sala:', error);
      return {
        content: [{
          type: "text",
          text: `Erro ao buscar registros: ${error.message}`
        }]
      };
    }
  }
);

// Tool to fetch cleaning photos with entry and exit times
server.registerTool(
  "buscar_fotos",
  {
    title: "Buscar Fotos da Limpeza",
    description: "Busca as fotos de entrada e saída da limpeza de uma sala",
    inputSchema: {
      sala: z.string().describe("Nome da sala (ex: SALA 28 (BANHEIRO))"),
      data_inicio: z.string().describe("Data de início no formato DD/MM/YYYY").optional(),
      data_fim: z.string().describe("Data de fim no formato DD/MM/YYYY").optional()
    }
  },
  async ({ sala, data_inicio, data_fim }) => {
    try {
      if (!sala) {
        throw new Error('O parâmetro "sala" é obrigatório');
      }
      
      // Helper function to parse dates from DD/MM/YYYY format
      const parseDate = (dateStr: string): Date | null => {
        if (!dateStr) return null;
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
      const validResults = searchResults.filter((result: any) => 
        result.score >= MIN_SCORE
      );

      if (validResults.length === 0) {
        throw new Error(`Nenhuma sala encontrada que corresponda a "${sala}". Por favor, verifique o nome e tente novamente.`);
      }

      // Parse date range or default to today
      const startDate = data_inicio ? parseDate(data_inicio) : new Date();
      if (startDate) startDate.setHours(0, 0, 0, 0);
      
      const endDate = data_fim ? parseDate(data_fim) : new Date();
      if (endDate) endDate.setHours(23, 59, 59, 999);
      
      const filterByDate = Boolean(data_inicio || data_fim);

      // Process each valid result
      const results = [];
      for (const result of validResults) {
        // Find history entries within date range
        const filteredEntries = (result.history || []).filter((entry: any) => {
          if (!entry.date) return false;
          const entryDate = new Date(entry.date);
          const isAfterStart = !startDate || entryDate >= startDate;
          const isBeforeEnd = !endDate || entryDate <= endDate;
          return isAfterStart && isBeforeEnd;
        });

        if (filteredEntries.length === 0) continue;
        
        // Sort by date descending (newest first)
        filteredEntries.sort((a: any, b: any) => 
          new Date(b.date).getTime() - new Date(a.date).getTime()
        );

        // Get the most recent entry if available
        const latestEntry = filteredEntries[0];
        if (!latestEntry) continue;

        // Get RESELLER_API from environment
        const apiBaseUrl = process.env.RESELLER_API;
        if (!apiBaseUrl) {
          throw new Error('RESELLER_API não está configurado no ambiente');
        }

        // Create photo URLs
        const photos: any = {};
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
      
      const formattedResults = results.map(result => 
        `Sala: ${result.sala}\n` +
        `Data: ${new Date(result.data).toLocaleString('pt-BR')}\n` +
        'Fotos:\n' +
        (result.fotos.entrada ? `- Entrada: ${result.fotos.entrada}\n` : '') +
        (result.fotos.saida ? `- Saída: ${result.fotos.saida}\n` : '') +
        'A busca retorna apenas os registros mais recentes para os dias selecionados. Se estiver procurando algo específico, indique o dia e horário desejado.'
      ).join('\n---\n');

      return {
        content: [{
          type: "text",
          text: `Fotos de limpeza encontradas ${dateRangeText}:\n\n${formattedResults}`
        }]
      };
    } catch (error) {
      console.error('Error in buscar_fotos_limpeza:', error);
      return {
        content: [{
          type: "text",
          text: `Erro ao buscar fotos de limpeza: ${error.message}`
        }]
      };
    }
  }
);

// Tool to export cleaning records to Excel
server.registerTool(
  "exportar_registros",
  {
    title: "Exportar Registros de Limpeza",
    description: "Exporta os registros de limpeza para um arquivo Excel",
    inputSchema: {
      sala: z.string().describe("Nome da sala (opcional, ex: SALA 28 (BANHEIRO))").optional(),
      data_inicio: z.string().describe("Data de início no formato DD/MM/YYYY").optional(),
      data_fim: z.string().describe("Data de fim no formato DD/MM/YYYY").optional(),
      dias_anteriores: z.number().describe("Número de dias anteriores para exportar (opcional)").optional()
    }
  },
  async ({ sala, data_inicio, data_fim, dias_anteriores }) => {
    try {
      // Parse date range
      const parseDate = (dateStr: string): Date | null => {
        if (!dateStr) return null;
        const [day, month, year] = dateStr.split('/').map(Number);
        return new Date(year, month - 1, day);
      };

      // Set up date range
      let startDate: Date;
      let endDate: Date = new Date();
      
      if (dias_anteriores) {
        startDate = subDays(new Date(), dias_anteriores);
      } else if (data_inicio) {
        startDate = parseDate(data_inicio) || new Date(0);
      } else {
        startDate = subDays(new Date(), 7); // Default to last 7 days
      }

      if (data_fim) {
        endDate = parseDate(data_fim) || new Date();
      }

      // Set time to start and end of day
      startDate = startOfDay(startDate);
      endDate = endOfDay(endDate);

      console.log(`Exportando registros de ${startDate.toISOString()} a ${endDate.toISOString()}`);

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
        ? searchResults.filter((item: any) => item.score >= MIN_SCORE)
        : searchResults;

      if (validItems.length === 0) {
        throw new Error('Nenhuma sala encontrada com os critérios fornecidos');
      }

      // Get the item IDs for the second query
      const itemIds = validItems.map((item: any) => item._id);

      // Now fetch the full items with filtered history
      const items = await db.collection('items')
        .aggregate([
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
        ])
        .toArray();

      if (!items || items.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Nenhum registro encontrado para o período selecionado.'
          }]
        };
      }

      console.log(`Encontrados ${items.length} itens com histórico`);

      // Prepare data for export
      const exportData = [];
      let totalEntries = 0;

      // Process each item and its history
      for (const item of items) {
        if (!item.history || item.history.length === 0) continue;

        // Sort history by date (newest first)
        const sortedHistory = [...item.history].sort((a, b) => 
          new Date(b.date).getTime() - new Date(a.date).getTime()
        );

        // Process each history entry
        for (const entry of sortedHistory) {
          try {
            exportData.push({
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
            totalEntries++;
          } catch (err) {
            console.error('Error processing entry:', err);
          }
        }
      }

      if (exportData.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Nenhum dado disponível para exportação após filtragem.'
          }]
        };
      }

      console.log(`Exportando ${totalEntries} registros para Excel`);

      // Create worksheet
      const worksheet = XLSX.utils.json_to_sheet(exportData);
      
      // Auto-size columns
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
        { wch: 50 }  // Observações
      ];
      worksheet['!cols'] = columnWidths;

      // Create workbook
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Histórico de Limpeza');

      // Generate file name with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `limpeza_export_${timestamp}.xlsx`;
      const filePath = path.join(exportsDir, fileName);

      // Write to file
      XLSX.writeFile(workbook, filePath);

      console.log(`Arquivo exportado com sucesso: ${filePath}`);

      // Read the file as base64
      const fileData = fs.readFileSync(filePath, { encoding: 'base64' });
      
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
    } catch (error) {
      console.error('Erro ao exportar registros:', error);
      return {
        content: [{
          type: 'text',
          text: `Erro ao exportar registros: ${error.message}`
        }]
      };
    }
  }
);

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  try {
    await client.close();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Start receiving messages on stdin and sending messages on stdout
try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (error) {
  console.error('Failed to start server:', error);
  await client.close();
  process.exit(1);
}