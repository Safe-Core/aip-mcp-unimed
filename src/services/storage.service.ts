import { Storage } from '@google-cloud/storage';
import { gcsConfig, validateGcsConfig } from '../config/gcs.config';
import * as path from 'path';
import * as crypto from 'crypto';

export class StorageService {
  private storage: Storage;
  private bucketName: string;
  private isConfigured: boolean;

  constructor() {
    this.isConfigured = validateGcsConfig();
    
    if (this.isConfigured) {
      this.storage = new Storage({
        projectId: gcsConfig.credentials.project_id,
        credentials: gcsConfig.credentials
      });
      this.bucketName = gcsConfig.bucketName;
    } else {
      console.warn('Google Cloud Storage não está configurado corretamente. Verifique as variáveis de ambiente.');
    }
  }

  /**
   * Uploads a file to Google Cloud Storage and returns a signed URL
   * @param filePath Local path of the file to be uploaded or Buffer with the file content
   * @param destinationPath Destination path in the bucket (optional)
   * @param options Additional options
   * @returns Signed URL for downloading the file
   */
  async uploadFile(
    filePath: string | Buffer, 
    destinationPath?: string, 
    options: { contentType?: string } = {}
  ): Promise<string> {
    if (!this.isConfigured) {
      throw new Error('Google Cloud Storage não está configurado corretamente');
    }

    try {
      const bucket = this.storage.bucket(this.bucketName);
      
      // Generates a unique file name if not specified
      const fileName = destinationPath || (typeof filePath === 'string' 
        ? this.generateUniqueFileName(path.basename(filePath))
        : this.generateUniqueFileName('export.xlsx'));
      
      const fullPath = path.posix.join(gcsConfig.basePath, fileName);
      const file = bucket.file(fullPath);
      
      // Configures the file metadata
      const metadata = {
        contentType: options.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        cacheControl: 'public, max-age=86400',
        metadata: {
          uploadedBy: 'aip-mcp-unimed',
          temporary: 'true',
          generatedAt: new Date().toISOString()
        }
      };

      // Uploads the file or buffer
      if (typeof filePath === 'string') {
        // Upload from a local file
        await bucket.upload(filePath, {
          destination: fullPath,
          metadata
        });
      } else {
        // Upload from a buffer
        await new Promise((resolve, reject) => {
          const stream = file.createWriteStream({
            metadata,
            resumable: false
          });
          
          stream.on('error', reject);
          stream.on('finish', resolve);
          
          stream.end(filePath);
        });
      }
      
      // console.log(`Arquivo enviado para ${fullPath} (${typeof filePath === 'string' ? 'arquivo' : 'buffer'})`);
      
      // Generates a signed URL for download
      const [signedUrl] = await file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + (gcsConfig.signedUrlExpiration * 1000), // Converte para milissegundos
      });

      // Schedules the file deletion after the expiration time
      this.scheduleFileDeletion(fullPath, gcsConfig.signedUrlExpiration * 1000);

      return signedUrl;
    } catch (error) {
      console.error('Erro ao fazer upload do arquivo para o Google Cloud Storage:', error);
      throw error;
    }
  }

  /**
   * Schedules the file deletion after the expiration time
   * @param filePath Path of the file in the bucket
   * @param delay Time in milliseconds until deletion
   */
  private async scheduleFileDeletion(filePath: string, delay: number): Promise<void> {
    if (!this.isConfigured) return;

    setTimeout(async () => {
      try {
        await this.storage.bucket(this.bucketName).file(filePath).delete();
        // console.log(`Arquivo ${filePath} removido do Google Cloud Storage`);
      } catch (error) {
        console.error(`Erro ao remover arquivo ${filePath}:`, error);
      }
    }, delay);
  }

  /**
   * Generates a unique file name with timestamp and a random hash
   * @param originalName Original file name
   * @returns Unique file name
   */
  private generateUniqueFileName(originalName: string): string {
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(4).toString('hex');
    const extension = path.extname(originalName);
    const baseName = path.basename(originalName, extension);
    
    return `${baseName}_${timestamp}_${randomString}${extension}`;
  }

  /**
   * Removes a file from Google Cloud Storage
   * @param filePath Path of the file in the bucket
   */
  async deleteFile(filePath: string): Promise<void> {
    if (!this.isConfigured) return;

    try {
      await this.storage.bucket(this.bucketName).file(filePath).delete();
      // console.log(`Arquivo ${filePath} removido com sucesso`);
    } catch (error) {
      console.error(`Erro ao remover arquivo ${filePath}:`, error);
      throw error;
    }
  }
}

export const storageService = new StorageService();
