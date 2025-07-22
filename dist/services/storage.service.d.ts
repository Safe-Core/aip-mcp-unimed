export declare class StorageService {
    private storage;
    private bucketName;
    private isConfigured;
    constructor();
    /**
     * Uploads a file to Google Cloud Storage and returns a signed URL
     * @param filePath Local path of the file to be uploaded or Buffer with the file content
     * @param destinationPath Destination path in the bucket (optional)
     * @param options Additional options
     * @returns Signed URL for downloading the file
     */
    uploadFile(filePath: string | Buffer, destinationPath?: string, options?: {
        contentType?: string;
    }): Promise<string>;
    /**
     * Schedules the file deletion after the expiration time
     * @param filePath Path of the file in the bucket
     * @param delay Time in milliseconds until deletion
     */
    private scheduleFileDeletion;
    /**
     * Generates a unique file name with timestamp and a random hash
     * @param originalName Original file name
     * @returns Unique file name
     */
    private generateUniqueFileName;
    /**
     * Removes a file from Google Cloud Storage
     * @param filePath Path of the file in the bucket
     */
    deleteFile(filePath: string): Promise<void>;
}
export declare const storageService: StorageService;
