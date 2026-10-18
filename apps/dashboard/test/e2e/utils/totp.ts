import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(secret: string): Buffer {
	let bits = "";
	for (const character of secret.replaceAll("=", "").toUpperCase()) {
		const value = BASE32_ALPHABET.indexOf(character);
		if (value === -1) {
			throw new Error(`Invalid base32 character: ${character}`);
		}
		bits += value.toString(2).padStart(5, "0");
	}
	const bytes: number[] = [];
	for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
		bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
	}
	return Buffer.from(bytes);
}

export function totpCode(secret: string, now = Date.now()): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
	const digest = createHmac("sha1", decodeBase32(secret))
		.update(counter)
		.digest();
	const offset = (digest.at(-1) ?? 0) % 16;
	const binary = digest.readUInt32BE(offset) % 2 ** 31;
	return (binary % 1_000_000).toString().padStart(6, "0");
}
