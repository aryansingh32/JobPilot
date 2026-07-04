import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
const ALGORITHM = 'aes-256-gcm';
function getSecretKey() {
    const key = process.env.APP_SECRET_KEY || 'default_secret_key_32_bytes_long.';
    if (key.length !== 32) {
        return Buffer.from(key.padEnd(32, '0').slice(0, 32));
    }
    return Buffer.from(key);
}
export const cryptoService = {
    encrypt(text) {
        const iv = randomBytes(16);
        const cipher = createCipheriv(ALGORITHM, getSecretKey(), iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag().toString('hex');
        return `${iv.toString('hex')}:${authTag}:${encrypted}`;
    },
    decrypt(text) {
        const [ivHex, authTagHex, encryptedHex] = text.split(':');
        const decipher = createDecipheriv(ALGORITHM, getSecretKey(), Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
};
//# sourceMappingURL=crypto-service.js.map