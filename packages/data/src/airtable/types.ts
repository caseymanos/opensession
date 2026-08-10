export type AirtablePrimitive = boolean | number | string;

export type AirtableCellValue =
  | AirtablePrimitive
  | null
  | readonly AirtablePrimitive[]
  | readonly Record<string, unknown>[]
  | Record<string, unknown>;

export type AirtableFields = Record<string, AirtableCellValue>;

export interface AirtableRecord<
  TFields extends AirtableFields = AirtableFields,
> {
  id: string;
  createdTime: string;
  fields: TFields;
}

export interface AirtableListOptions {
  fields?: readonly string[];
  filterByFormula?: string;
  maxRecords?: number;
  pageSize?: number;
  sort?: readonly {
    direction?: "asc" | "desc";
    field: string;
  }[];
}

export interface AirtableFieldSchema {
  description?: string | undefined;
  id: string;
  name: string;
  options?: Record<string, unknown> | undefined;
  type: string;
}

export interface AirtableTableSchema {
  description?: string | undefined;
  fields: AirtableFieldSchema[];
  id: string;
  name: string;
  primaryFieldId: string;
}

export interface AirtableBaseSchema {
  tables: AirtableTableSchema[];
}

export type AirtableFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface AirtableClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const systemClock: AirtableClock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
