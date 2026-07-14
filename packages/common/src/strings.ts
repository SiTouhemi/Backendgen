function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0);
}

export function upperFirst(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

export function lowerFirst(value: string): string {
  return value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1);
}

export function pascalCase(value: string): string {
  return words(value)
    .map((part) => upperFirst(part.toLowerCase()))
    .join("");
}

export function camelCase(value: string): string {
  return lowerFirst(pascalCase(value));
}

export function kebabCase(value: string): string {
  return words(value)
    .map((part) => part.toLowerCase())
    .join("-");
}

export function snakeCase(value: string): string {
  return words(value)
    .map((part) => part.toLowerCase())
    .join("_");
}

const IRREGULAR_PLURALS: ReadonlyMap<string, string> = new Map([
  ["person", "people"],
  ["child", "children"],
  ["man", "men"],
  ["woman", "women"],
]);

/**
 * Deterministic, dependency-free English pluralisation. It intentionally covers
 * only the cases the compiler needs for route and relation naming; anything more
 * exotic should be overridden explicitly in the specification.
 */
export function pluralize(value: string): string {
  const lower = value.toLowerCase();
  const irregular = IRREGULAR_PLURALS.get(lower);
  if (irregular !== undefined) {
    return irregular;
  }
  if (/(s|x|z|ch|sh)$/.test(lower)) {
    return `${lower}es`;
  }
  if (/[^aeiou]y$/.test(lower)) {
    return `${lower.slice(0, -1)}ies`;
  }
  return `${lower}s`;
}
