#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

interface SchemaField {
  const?: string;
  description?: string;
  enum?: string[];
  name: string;
  required: boolean;
  type: string;
}

interface SchemaType {
  description?: string;
  fields: SchemaField[];
  primitive?: "input-file";
}

interface SchemaMethod {
  description?: string;
  httpMethod: "GET" | "POST";
  params: SchemaField[];
  returns: string;
}

interface Schema {
  baseUrl: string;
  methods: Record<string, SchemaMethod>;
  types: Record<string, SchemaType>;
  version: string;
}

const SCHEMA_PATH = resolve(import.meta.dir, "..", "schema", "telegram.json");
// `bot-api-spec/` lives under the Telegram provider directory, so the
// generated output sits as a sibling (`../../generated`) of the bot-api-spec
// folder rather than far away in the package tree.
const OUTPUT_DIR = resolve(import.meta.dir, "..", "..", "generated");

const FILE_BANNER = `// GENERATED FILE — do not edit by hand.
// Source: providers/telegram/bot-api-spec/schema/telegram.json
// Regenerate with: bun run gen:telegram
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const loadSchema = async (): Promise<Schema> => {
  const raw = await readFile(SCHEMA_PATH, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  // Fail fast with a clear message if the schema file is malformed rather
  // than letting downstream generators throw confusing property-access errors.
  if (
    !(isRecord(parsed) && isRecord(parsed.types) && isRecord(parsed.methods))
  ) {
    throw new Error(
      `Invalid schema at ${SCHEMA_PATH}: expected object with "types" and "methods" object maps`
    );
  }
  return parsed as unknown as Schema;
};

// Translate the schema's TypeRef DSL into a TypeScript type expression.
// Supported forms:
//   string | integer | boolean | float | any
//   Ref:<TypeName>
//   Array:<Inner>
//   Union:<A>|<B>|...   (members may be primitives or Ref:X)
const toTs = (type: string): string => {
  if (type === "string") {
    return "string";
  }
  if (type === "integer" || type === "float") {
    return "number";
  }
  if (type === "boolean") {
    return "boolean";
  }
  if (type === "any") {
    return "unknown";
  }
  // `InputFile` is documented in README as a top-level TypeRef primitive so
  // bare occurrences (e.g. `"type": "InputFile"` or `"Union:InputFile|string"`)
  // resolve without requiring the `Ref:` prefix.
  if (type === "InputFile") {
    return "InputFile";
  }
  if (type.startsWith("Ref:")) {
    const name = type.slice("Ref:".length);
    if (name === "InputFile") {
      return "InputFile";
    }
    return name;
  }
  if (type.startsWith("Array:")) {
    const inner = type.slice("Array:".length);
    return `Array<${toTs(inner)}>`;
  }
  if (type.startsWith("Union:")) {
    const rest = type.slice("Union:".length);
    return rest.split("|").map(toTs).join(" | ");
  }
  throw new Error(`Unknown type expression: ${type}`);
};

const renderFieldType = (field: SchemaField): string => {
  if (field.const !== undefined) {
    return JSON.stringify(field.const);
  }
  if (field.enum && field.enum.length > 0) {
    return field.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  return toTs(field.type);
};

const renderTypes = (schema: Schema): string => {
  const lines: string[] = [];
  lines.push(FILE_BANNER);
  lines.push("");
  lines.push("export type InputFile = string | Blob;");
  lines.push("");

  for (const [name, def] of Object.entries(schema.types)) {
    if (def.primitive === "input-file") {
      continue;
    }
    if (def.description) {
      lines.push(`/** ${def.description} */`);
    }
    lines.push(`export interface ${name} {`);
    for (const field of def.fields) {
      if (field.description) {
        lines.push(`  /** ${field.description} */`);
      }
      const optional = field.required ? "" : "?";
      lines.push(`  ${field.name}${optional}: ${renderFieldType(field)};`);
    }
    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
};

// Build the TS interface name for a method's params (e.g. `sendMessage` →
// `SendMessageParams`). The schema is hand-written, but we still fail loudly
// on an empty key so a malformed entry can't silently produce an unusable
// `undefinedParams` interface that compiles but is broken at every call site.
const paramsInterfaceName = (methodName: string): string => {
  if (!methodName) {
    throw new Error(
      "Telegram schema contains a method with an empty name; refusing to generate"
    );
  }
  return `${methodName[0]?.toUpperCase()}${methodName.slice(1)}Params`;
};

const renderMethods = (schema: Schema): string => {
  const lines: string[] = [];
  lines.push(FILE_BANNER);
  lines.push("");
  lines.push("import type {");
  const typeImports = Object.keys(schema.types)
    .filter((name) => schema.types[name]?.primitive !== "input-file")
    .sort();
  for (const typeName of typeImports) {
    lines.push(`  ${typeName},`);
  }
  lines.push("  InputFile,");
  lines.push('} from "./types";');
  lines.push("");

  // Emit one params interface per method.
  for (const [methodName, def] of Object.entries(schema.methods)) {
    const interfaceName = paramsInterfaceName(methodName);
    if (def.description) {
      lines.push(`/** ${def.description} */`);
    }
    if (def.params.length === 0) {
      lines.push(`export type ${interfaceName} = Record<string, never>;`);
    } else {
      lines.push(`export interface ${interfaceName} {`);
      for (const field of def.params) {
        if (field.description) {
          lines.push(`  /** ${field.description} */`);
        }
        const optional = field.required ? "" : "?";
        lines.push(`  ${field.name}${optional}: ${renderFieldType(field)};`);
      }
      lines.push("}");
    }
    lines.push("");
  }

  // Emit the Methods map: method name -> { params, result }.
  lines.push(
    "/** Bot API method map. Used by the runtime client for type-safe invoke(). */"
  );
  lines.push("export interface Methods {");
  for (const [methodName, def] of Object.entries(schema.methods)) {
    const paramsName = paramsInterfaceName(methodName);
    const returnType = toTs(def.returns);
    lines.push(`  ${methodName}: {`);
    lines.push(`    params: ${paramsName};`);
    lines.push(`    result: ${returnType};`);
    lines.push("  };");
  }
  lines.push("}");
  lines.push("");

  lines.push("export type MethodName = keyof Methods;");
  lines.push("");
  lines.push(`export const BASE_URL = ${JSON.stringify(schema.baseUrl)};`);
  lines.push(`export const API_VERSION = ${JSON.stringify(schema.version)};`);
  lines.push("");

  return lines.join("\n");
};

const main = async (): Promise<void> => {
  const schema = await loadSchema();
  await mkdir(OUTPUT_DIR, { recursive: true });

  const typesPath = resolve(OUTPUT_DIR, "types.ts");
  const methodsPath = resolve(OUTPUT_DIR, "methods.ts");

  await writeFile(typesPath, renderTypes(schema));
  await writeFile(methodsPath, renderMethods(schema));

  console.log(`Wrote ${typesPath}`);
  console.log(`Wrote ${methodsPath}`);
};

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
