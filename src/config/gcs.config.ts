import dotenv from 'dotenv';

dotenv.config();

export const gcsConfig = {
  // Bucket name in Google Cloud Storage
  bucketName: process.env.GCS_BUCKET_NAME || 'aip-mcp-unimed-exports',
  
  // Base path inside the bucket where files will be stored
  basePath: 'exports',
  
  // Expiration time of the signed URL in seconds (1 hour = 3600 seconds)
  signedUrlExpiration: 3600,
  
  // Authentication configuration (will be loaded from environment variables)
  credentials: {
    type: 'service_account',
    project_id: process.env.GCS_PROJECT_ID,
    private_key_id: process.env.GCS_PRIVATE_KEY_ID,
    private_key: process.env.GCS_PRIVATE_KEY ? process.env.GCS_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    client_email: process.env.GCS_CLIENT_EMAIL,
    client_id: process.env.GCS_CLIENT_ID,
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: process.env.GCS_CLIENT_CERT_URL,
    universe_domain: 'googleapis.com'
  }
} as const;

// Validates if the necessary credentials are configured
export function validateGcsConfig() {
  if (!process.env.GCS_PROJECT_ID || 
      !process.env.GCS_PRIVATE_KEY_ID || 
      !process.env.GCS_PRIVATE_KEY || 
      !process.env.GCS_CLIENT_EMAIL || 
      !process.env.GCS_CLIENT_ID || 
      !process.env.GCS_CLIENT_CERT_URL) {
    console.warn('Google Cloud Storage não está totalmente configurado. Certifique-se de configurar todas as variáveis de ambiente necessárias.');
    return false;
  }
  return true;
}
