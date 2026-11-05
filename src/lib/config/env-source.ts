/**
 * Environment values as config schemas should see them: `KEY=` (empty, as in
 * .env.example) means "not set", not an empty value that fails validation.
 */
export function definedEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== "") out[key] = value;
  }
  return out;
}
