import {
  AirtableClient,
  AirtableError,
  hashAirtableValue,
} from "@sessionbox-killer/data/airtable/internal";

export default {
  async fetch(): Promise<Response> {
    const client = new AirtableClient({
      baseId: "appFixture",
      fetcher: async () =>
        Response.json({
          records: [
            {
              createdTime: "2026-08-08T00:00:00.000Z",
              fields: { ID: "evt_fixture" },
              id: "recFixture",
            },
          ],
        }),
      token: "fixture-token",
    });
    const records = await client.listRecords("tblEvents");
    const digest = await hashAirtableValue(records[0]?.fields ?? null);
    const safeError = new AirtableError({
      code: "FIXTURE_ERROR",
      retryable: false,
      status: 400,
    });

    return Response.json({
      digest,
      error: safeError.message,
      recordId: records[0]?.id,
    });
  },
} satisfies ExportedHandler;
