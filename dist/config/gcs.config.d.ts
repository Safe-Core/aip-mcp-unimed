export declare const gcsConfig: {
    readonly bucketName: string;
    readonly basePath: "exports";
    readonly signedUrlExpiration: 3600;
    readonly credentials: {
        readonly type: "service_account";
        readonly project_id: string;
        readonly private_key_id: string;
        readonly private_key: string;
        readonly client_email: string;
        readonly client_id: string;
        readonly auth_uri: "https://accounts.google.com/o/oauth2/auth";
        readonly token_uri: "https://oauth2.googleapis.com/token";
        readonly auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs";
        readonly client_x509_cert_url: string;
        readonly universe_domain: "googleapis.com";
    };
};
export declare function validateGcsConfig(): boolean;
