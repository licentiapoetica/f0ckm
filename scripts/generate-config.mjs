#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const DEFAULT_CONFIG_YAML = path.join(rootDir, 'config.yaml');
const DEFAULT_CONFIG_JSON = path.join(rootDir, 'config.json');
const EXAMPLE_CONFIG_YAML = path.join(rootDir, 'config_example.yaml');
const EXAMPLE_CONFIG_JSON = path.join(rootDir, 'config_example.json');

function convertYamlToJson(yamlPath, jsonPath) {
    if (!fs.existsSync(yamlPath)) {
        console.error(`[CONFIG-GEN] Error: Source YAML file not found at ${yamlPath}`);
        return false;
    }
    try {
        const yamlContent = fs.readFileSync(yamlPath, 'utf8');
        const parsed = YAML.parse(yamlContent);
        if (parsed === null || typeof parsed !== 'object') {
            throw new Error('Parsed YAML is not an object');
        }
        const jsonContent = JSON.stringify(parsed, null, 2) + '\n';
        fs.writeFileSync(jsonPath, jsonContent, 'utf8');
        console.log(`[CONFIG-GEN] Generated ${path.relative(rootDir, jsonPath)} from ${path.relative(rootDir, yamlPath)}`);
        return true;
    } catch (err) {
        console.error(`[CONFIG-GEN] Failed to generate JSON from ${path.relative(rootDir, yamlPath)}: ${err.message}`);
        return false;
    }
}

function convertJsonToYaml(jsonPath, yamlPath) {
    if (!fs.existsSync(jsonPath)) {
        console.error(`[CONFIG-GEN] Error: Source JSON file not found at ${jsonPath}`);
        return false;
    }
    try {
        const jsonContent = fs.readFileSync(jsonPath, 'utf8');
        const parsed = JSON.parse(jsonContent);
        const doc = new YAML.Document(parsed);
        const yamlContent = String(doc);
        fs.writeFileSync(yamlPath, yamlContent, 'utf8');
        console.log(`[CONFIG-GEN] Generated ${path.relative(rootDir, yamlPath)} from ${path.relative(rootDir, jsonPath)}`);
        return true;
    } catch (err) {
        console.error(`[CONFIG-GEN] Failed to generate YAML from ${path.relative(rootDir, jsonPath)}: ${err.message}`);
        return false;
    }
}

const args = process.argv.slice(2);
const isWatch = args.includes('--watch') || args.includes('-w');
const isToYaml = args.includes('--to-yaml');
const includeAll = args.includes('--all') || args.includes('--example');

if (isToYaml) {
    convertJsonToYaml(DEFAULT_CONFIG_JSON, DEFAULT_CONFIG_YAML);
    if (includeAll || fs.existsSync(EXAMPLE_CONFIG_JSON)) {
        convertJsonToYaml(EXAMPLE_CONFIG_JSON, EXAMPLE_CONFIG_YAML);
    }
    process.exit(0);
}

// Initial generation
let success = convertYamlToJson(DEFAULT_CONFIG_YAML, DEFAULT_CONFIG_JSON);
if (includeAll && fs.existsSync(EXAMPLE_CONFIG_YAML)) {
    convertYamlToJson(EXAMPLE_CONFIG_YAML, EXAMPLE_CONFIG_JSON);
}

if (!success && !isWatch) {
    process.exit(1);
}

if (isWatch) {
    console.log(`[CONFIG-GEN] Watching ${path.relative(rootDir, DEFAULT_CONFIG_YAML)} for changes... (Press Ctrl+C to stop)`);
    let debounceTimer = null;
    fs.watch(DEFAULT_CONFIG_YAML, (eventType) => {
        if (eventType === 'change' || eventType === 'rename') {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                console.log(`[CONFIG-GEN] File change detected, re-generating config.json...`);
                convertYamlToJson(DEFAULT_CONFIG_YAML, DEFAULT_CONFIG_JSON);
            }, 100);
        }
    });
}
