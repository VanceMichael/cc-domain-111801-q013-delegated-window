import { readFile } from 'node:fs/promises';
import { fixtureSource } from '../src/fixture-source.mjs';
import { portalServer } from "../src/portal.mjs";
const fixture = JSON.parse(await readFile(new URL('../fixtures/source.json', import.meta.url), 'utf8'));
const source = await fixtureSource(fixture, { port: Number(process.env.PORT ?? 0) });
console.log('本地合作源：' + source.url);
const portal = await portalServer(fixture.portal); console.log("合作门户：" + portal.url);
process.on('SIGTERM', async () => { await source.close(); await portal.close(); });
process.on('SIGINT', async () => { await source.close(); await portal.close(); });
