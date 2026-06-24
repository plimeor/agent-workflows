// Minimal JSON Schema validator — enough to validate a subagent's structured-output result.
// Supports: type, properties, required, items, enum, const, additionalProperties,
// minimum/maximum, minItems/maxItems, anyOf/oneOf/allOf, nullable via type arrays.

function typeOf(v) {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v; // string|number|boolean|object|undefined
}

function matchesType(v, t) {
	if (t === "integer") return typeof v === "number" && Number.isInteger(v);
	if (t === "number") return typeof v === "number";
	return typeOf(v) === t;
}

export function validate(value, schema, path = "$") {
	const errors = [];
	walk(value, schema, path, errors);
	return { ok: errors.length === 0, errors };
}

function walk(value, schema, path, errors) {
	if (!schema || typeof schema !== "object") return;

	if (Array.isArray(schema.type)) {
		if (!schema.type.some((t) => matchesType(value, t))) {
			errors.push(
				`${path}: expected one of [${schema.type.join(", ")}], got ${typeOf(value)}`,
			);
			return;
		}
	} else if (schema.type) {
		if (!matchesType(value, schema.type)) {
			errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
			return;
		}
	}

	if (
		"const" in schema &&
		JSON.stringify(value) !== JSON.stringify(schema.const)
	) {
		errors.push(`${path}: must equal const ${JSON.stringify(schema.const)}`);
	}
	if (
		Array.isArray(schema.enum) &&
		!schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
	) {
		errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
	}

	for (const key of ["anyOf", "oneOf", "allOf"]) {
		if (!Array.isArray(schema[key])) continue;
		const results = schema[key].map((s) => validate(value, s, path));
		const passing = results.filter((r) => r.ok).length;
		if (key === "anyOf" && passing < 1)
			errors.push(`${path}: matched none of anyOf`);
		if (key === "oneOf" && passing !== 1)
			errors.push(
				`${path}: must match exactly one of oneOf (matched ${passing})`,
			);
		if (key === "allOf" && passing !== schema[key].length)
			errors.push(`${path}: must match all of allOf`);
	}

	const t = typeOf(value);
	if (t === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum)
			errors.push(`${path}: < minimum ${schema.minimum}`);
		if (typeof schema.maximum === "number" && value > schema.maximum)
			errors.push(`${path}: > maximum ${schema.maximum}`);
	}
	if (t === "string") {
		if (typeof schema.minLength === "number" && value.length < schema.minLength)
			errors.push(`${path}: shorter than ${schema.minLength}`);
		if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
			errors.push(`${path}: longer than ${schema.maxLength}`);
	}
	if (t === "array") {
		if (typeof schema.minItems === "number" && value.length < schema.minItems)
			errors.push(`${path}: fewer than ${schema.minItems} items`);
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
			errors.push(`${path}: more than ${schema.maxItems} items`);
		if (schema.items) {
			for (const [i, item] of value.entries()) {
				walk(item, schema.items, `${path}[${i}]`, errors);
			}
		}
	}
	if (t === "object") {
		const props = schema.properties || {};
		for (const req of schema.required || []) {
			if (!(req in value))
				errors.push(`${path}: missing required property '${req}'`);
		}
		for (const [k, v] of Object.entries(value)) {
			if (props[k]) walk(v, props[k], `${path}.${k}`, errors);
			else if (schema.additionalProperties === false)
				errors.push(`${path}: unexpected property '${k}'`);
			else if (
				schema.additionalProperties &&
				typeof schema.additionalProperties === "object"
			)
				walk(v, schema.additionalProperties, `${path}.${k}`, errors);
		}
	}
}
