import { GENERIC_LABEL_RE, IG_URL_RE } from "./types";

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readTimestamp(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Instagram exports use seconds; tolerate ms.
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return readTimestamp(asNumber);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function looksLikeUsername(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return false;
  if (GENERIC_LABEL_RE.test(trimmed)) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;
  return /^[@a-z0-9._-]+$/i.test(trimmed);
}

export function normalizeUsername(value: string): string {
  return value.replace(/^@+/, "").trim();
}

export function readStringListData(entry: Record<string, unknown>): {
  href: string | null;
  savedAt: Date | null;
  value: string | null;
} {
  const list =
    (Array.isArray(entry.string_list_data) && entry.string_list_data) ||
    (Array.isArray(entry.stringListData) && entry.stringListData) ||
    null;

  if (!list) {
    return { href: null, savedAt: null, value: null };
  }

  for (const raw of list) {
    const data = asRecord(raw);
    if (!data) continue;
    const href = readString(data.href);
    if (href) {
      return {
        href,
        savedAt: readTimestamp(data.timestamp),
        value: readString(data.value),
      };
    }
  }

  const first = asRecord(list[0]);
  return {
    href: null,
    savedAt: first ? readTimestamp(first.timestamp) : null,
    value: first ? readString(first.value) : null,
  };
}

export function readAuthorUsername(
  entry: Record<string, unknown>,
  listValue: string | null = null,
): string | null {
  const title = readString(entry.title);
  if (title) return normalizeUsername(title);

  if (listValue && looksLikeUsername(listValue)) {
    return normalizeUsername(listValue);
  }

  const map = asRecord(entry.string_map_data) ?? asRecord(entry.stringMapData);
  if (map) {
    for (const [key, value] of Object.entries(map)) {
      if (!/name|author|username|channel|creator|profile/i.test(key)) continue;
      const data = asRecord(value);
      const fromValue = readString(data?.value);
      if (fromValue && looksLikeUsername(fromValue)) {
        return normalizeUsername(fromValue);
      }
    }

    const nameField = asRecord(map.Name) ?? asRecord(map.name);
    const fromName = readString(nameField?.value);
    if (fromName && looksLikeUsername(fromName)) {
      return normalizeUsername(fromName);
    }
  }

  return null;
}

export function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (!node) return out;
  if (typeof node === "string") {
    if (IG_URL_RE.test(node) || node.includes("instagram.com/")) {
      out.push(node);
    }
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectHrefs(item, out);
    return out;
  }
  const obj = asRecord(node);
  if (!obj) return out;

  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase() === "href" && typeof value === "string") {
      out.push(value);
    } else {
      collectHrefs(value, out);
    }
  }
  return out;
}

export function readSavedOn(entry: Record<string, unknown>): {
  href: string | null;
  savedAt: Date | null;
  value: string | null;
} {
  const map = asRecord(entry.string_map_data) ?? asRecord(entry.stringMapData);
  if (map) {
    for (const [key, value] of Object.entries(map)) {
      if (!/saved|added|time/i.test(key)) continue;
      const data = asRecord(value);
      if (!data) continue;
      const href = readString(data.href);
      if (href) {
        return {
          href,
          savedAt: readTimestamp(data.timestamp),
          value: readString(data.value),
        };
      }
    }

    // Flat collections: Name.href + Added Time.timestamp
    const nameField = asRecord(map.Name) ?? asRecord(map.name);
    const href = readString(nameField?.href);
    if (href) {
      const addedTime =
        asRecord(map["Added Time"]) ??
        asRecord(map["Saved on"]) ??
        asRecord(map.Time);
      return {
        href,
        savedAt: readTimestamp(addedTime?.timestamp),
        value: readString(nameField?.value),
      };
    }

    // Fallback: first map entry with an href
    for (const value of Object.values(map)) {
      const data = asRecord(value);
      if (!data) continue;
      const href = readString(data.href);
      if (href) {
        return {
          href,
          savedAt: readTimestamp(data.timestamp),
          value: readString(data.value),
        };
      }
    }
  }

  return readStringListData(entry);
}

export function readLabelValuesList(entry: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(entry.label_values)) return entry.label_values;
  if (Array.isArray(entry.labelValues)) return entry.labelValues;
  return null;
}

export function isLabelValuesEntry(entry: Record<string, unknown>): boolean {
  return Boolean(readLabelValuesList(entry));
}

export function findLabeledValue(
  labelValues: unknown[],
  label: string,
): Record<string, unknown> | null {
  const wanted = label.toLowerCase();
  for (const raw of labelValues) {
    const lv = asRecord(raw);
    if (!lv) continue;
    const name = readString(lv.label);
    if (name && name.toLowerCase() === wanted) return lv;
  }
  return null;
}

export function findTitledDict(
  labelValues: unknown[],
  title: string,
): unknown[] | null {
  const wanted = title.toLowerCase();
  for (const raw of labelValues) {
    const lv = asRecord(raw);
    if (!lv) continue;
    const name = readString(lv.title);
    if (name && name.toLowerCase() === wanted) {
      return Array.isArray(lv.dict) ? lv.dict : [];
    }
  }
  return null;
}

export function readOwnerUsernameFromLabelValues(
  labelValues: unknown[],
): string | null {
  const ownerPeople = findTitledDict(labelValues, "Owner");
  if (!ownerPeople) return null;

  for (const personRaw of ownerPeople) {
    const person = asRecord(personRaw);
    if (!person) continue;
    const fields = Array.isArray(person.dict) ? person.dict : [];
    for (const fieldRaw of fields) {
      const field = asRecord(fieldRaw);
      if (!field) continue;
      const label = readString(field.label);
      if (!label || !/^username$/i.test(label)) continue;
      const value = readString(field.value);
      if (value && looksLikeUsername(value)) {
        return normalizeUsername(value);
      }
    }
  }

  // Fallback: display Name under Owner when Username is absent
  for (const personRaw of ownerPeople) {
    const person = asRecord(personRaw);
    if (!person) continue;
    const fields = Array.isArray(person.dict) ? person.dict : [];
    for (const fieldRaw of fields) {
      const field = asRecord(fieldRaw);
      if (!field) continue;
      const label = readString(field.label);
      if (!label || !/^name$/i.test(label)) continue;
      const value = readString(field.value);
      if (value && looksLikeUsername(value)) {
        return normalizeUsername(value);
      }
    }
  }

  return null;
}

export function readHrefFromLabelValues(labelValues: unknown[]): string | null {
  const urlField = findLabeledValue(labelValues, "URL");
  if (!urlField) return null;
  return readString(urlField.href) ?? readString(urlField.value);
}
