import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeJsonAtomic(file: string, value: unknown) {
	await writeFileAtomic(file, JSON.stringify(value, null, 2));
}

export async function writeTextAtomic(file: string, value: string) {
	await writeFileAtomic(file, value);
}

async function writeFileAtomic(file: string, value: string) {
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	await writeFile(tmp, value);
	await rename(tmp, file);
}
