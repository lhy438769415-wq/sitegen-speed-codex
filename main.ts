import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');
const { run } = await import('./solve.js');
const inputFile = join(process.env.MAKEFUN_INPUT_DIR ?? '/input', 'cases.json');
const outputFile = join(process.env.MAKEFUN_OUTPUT_DIR ?? '/output', 'answers.json');
const cases = JSON.parse(readFileSync(inputFile, 'utf8'));
const answers = cases.map(({ input }) => run(input));
writeFileSync(outputFile, JSON.stringify(answers));
