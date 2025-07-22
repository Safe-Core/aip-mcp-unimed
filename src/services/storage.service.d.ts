export declare class StorageService {
  constructor();
  uploadFile(filePath: string | Buffer, destinationPath?: string, options?: { contentType?: string }): Promise<string>;
  deleteFile(filePath: string): Promise<void>;
}
export declare const storageService: StorageService;
