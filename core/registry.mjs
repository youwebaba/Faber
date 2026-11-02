export const permissions = ['read', 'files', 'shell', 'computer', 'network', 'upgrade'];
const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'enum', 'const', 'anyOf', 'oneOf', 'description', 'title', 'default', '$schema']);

export function validateSchema(schema, path = 'schema') {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${path} must be a JSON schema object`);
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`${path}: unsupported schema keyword ${key}`);
  if (schema.type && !types.includes(schema.type)) throw new Error(`${path}: unsupported type`);
  if (!schema.type && !schema.anyOf && !schema.oneOf && !schema.enum && !('const' in schema)) throw new Error(`${path}: type or union is required`);
  if (schema.pattern) new RegExp(schema.pattern);
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new Error(`${path}: enum must be a nonempty array`);
  if (schema.properties && (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) throw new Error(`${path}: invalid properties`);
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || (!['minimum', 'maximum'].includes(key) && (!Number.isInteger(schema[key]) || schema[key] < 0)))) throw new Error(`${path}: invalid ${key}`);
  if (schema.properties) for (const [key, value] of Object.entries(schema.properties)) validateSchema(value, `${path}.${key}`);
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(schema.properties || {}, key)))) throw new Error(`${path}: invalid required properties`);
  if (schema.items) validateSchema(schema.items, `${path}.items`);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateSchema(schema.additionalProperties);
  for (const key of ['anyOf', 'oneOf']) if (schema[key]) {
    if (!Array.isArray(schema[key]) || !schema[key].length) throw new Error(`${path}: empty ${key}`);
    schema[key].forEach(item => validateSchema(item, path));
  }
}

export function validate(value, schema, path = 'args') {
  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf || schema.oneOf;
    const matches = options.filter(item => { try { validate(value, item, path); return true; } catch { return false; } }).length;
    if (!matches || (schema.oneOf && matches !== 1)) throw new Error(`${path}: does not match schema union`);
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) throw new Error(`${path}: invalid constant`);
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) throw new Error(`${path}: invalid enum value`);
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && !(schema.type === 'integer' ? Number.isInteger(value) : actual === schema.type)) throw new Error(`${path}: expected ${schema.type}`);
  if (actual === 'number') {
    if (!Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error(`${path}: number out of range`);
  }
  if (actual === 'string' && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) throw new Error(`${path}: invalid string`);
  if (actual === 'array') {
    if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems)) throw new Error(`${path}: array length out of range`);
    if (schema.items) value.forEach((item, index) => validate(item, schema.items, `${path}[${index}]`));
  }
  if (actual === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validate(item, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) throw new Error(`${path}.${key}: unknown property`);
      else if (typeof schema.additionalProperties === 'object') validate(item, schema.additionalProperties, `${path}.${key}`);
    }
  }
}

export function checkTool(tool) {
  if (!tool || !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name)) throw new Error('Invalid tool name');
  if (typeof tool.description !== 'string' || !tool.description.trim() || !permissions.includes(tool.permission) || typeof tool.execute !== 'function') throw new Error(`Invalid tool definition: ${tool.name}`);
  validateSchema(tool.parameters);
  if (tool.parameters.type !== 'object') throw new Error(`Tool ${tool.name} parameters must be an object`);
  if (tool.parameters.additionalProperties !== false) throw new Error(`Tool ${tool.name} must reject unknown arguments with additionalProperties:false`);
}

export function toolMetadata(tool) {
  return { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters), permission: tool.permission };
}
