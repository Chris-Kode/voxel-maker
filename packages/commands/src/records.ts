/**
 * ID-keyed records of a document (nodes, materials, volumes, animations)
 * are null-prototype maps: an absent caller-supplied ID such as "toString"
 * must never resolve to an inherited `Object.prototype` member and be
 * mistaken for an existing record (issue #103). `createDocument` and
 * `parseDocument` build the committed records this way; these helpers keep
 * staged records null-prototype whenever a command handler replaces a whole
 * record (deletes) or rebuilds the staging clone.
 */
export function nullPrototypeRecord<T>(
  entries: Iterable<readonly [string, T]>,
): Record<string, T> {
  const record: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries) {
    record[key] = value;
  }
  return record;
}

/** A null-prototype copy of `record` preserving key order and values. */
export function copyNullPrototype<T>(
  record: Readonly<Record<string, T>>,
): Record<string, T> {
  return nullPrototypeRecord(Object.entries(record));
}

/** A null-prototype copy of `record` with `key` removed. */
export function withoutRecordEntry<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  return nullPrototypeRecord(
    Object.entries(record).filter(([existingKey]) => existingKey !== key),
  );
}
