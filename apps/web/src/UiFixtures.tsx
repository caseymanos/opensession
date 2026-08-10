import { useCallback, useState } from "react";

import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Dialog,
  Drawer,
  EnvironmentBanner,
  ErrorSummary,
  StatePanel,
  TextField,
  ToastRegion,
  type AppEnvironment,
  type DataTableColumn,
  type ToastMessage,
  type ViewState,
} from "@sessionbox-killer/ui";
import { isAppEnvironment } from "@sessionbox-killer/ui/environment";

type FixtureState = "normal" | ViewState;

interface SpeakerRow {
  name: string;
  nextDue: string;
  readiness: string;
  status: string;
}

const fixtureStates: FixtureState[] = [
  "normal",
  "empty",
  "loading",
  "error",
  "permission",
];

const rows: SpeakerRow[] = [
  {
    name: "Mina Okafor",
    nextDue: "Headshot · Aug 11",
    readiness: "3 of 4",
    status: "Needs attention",
  },
  {
    name: "Jon Bell",
    nextDue: "Complete",
    readiness: "4 of 4",
    status: "Ready",
  },
];

const columns: DataTableColumn<SpeakerRow>[] = [
  {
    key: "name",
    header: "Speaker",
    render: (row) => <strong>{row.name}</strong>,
  },
  { key: "readiness", header: "Readiness", render: (row) => row.readiness },
  { key: "nextDue", header: "Next due", render: (row) => row.nextDue },
  { key: "status", header: "Status", render: (row) => row.status },
];

function getFixtureState(): FixtureState {
  const value = new URLSearchParams(window.location.search).get("state");
  return fixtureStates.includes(value as FixtureState)
    ? (value as FixtureState)
    : "normal";
}

function getFixtureEnvironment(): AppEnvironment {
  const value = new URLSearchParams(window.location.search).get("environment");
  return isAppEnvironment(value) ? value : "preview";
}

function getFixtureDemoFlag() {
  return new URLSearchParams(window.location.search).get("demo") !== "false";
}

function FixtureStateView({ state }: { state: FixtureState }) {
  if (state === "normal") {
    return (
      <DataTable
        caption="Speaker readiness fixture"
        columns={columns}
        getRowKey={(row) => row.name}
        rows={rows}
      />
    );
  }

  const descriptions: Record<ViewState, string> = {
    empty:
      "Invite a speaker or clear the current filters to populate this view.",
    error:
      "Your filters are preserved. Retry when the upstream service is available.",
    loading:
      "Fetching the latest readiness state without clearing cached content.",
    permission:
      "Ask an event owner for organizer access to view speaker readiness.",
  };

  return (
    <StatePanel
      description={descriptions[state]}
      onRetry={state === "error" ? () => undefined : undefined}
      state={state}
    />
  );
}

export function UiFixtures() {
  const fixtureState = getFixtureState();
  const environment = getFixtureEnvironment();
  const isDemoEvent = getFixtureDemoFlag();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const closeDialog = useCallback(() => {
    setDialogOpen(false);
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);
  const closeConfirm = useCallback(() => {
    setConfirmOpen(false);
  }, []);

  return (
    <main className="fixture-page" id="fixture-main">
      <EnvironmentBanner
        environment={environment}
        isDemoEvent={isDemoEvent}
        onReset={() => {
          setConfirmOpen(true);
        }}
      />

      <div className="fixture-content">
        <header className="fixture-heading">
          <div>
            <p className="overline">RAL-37 component fixtures</p>
            <h1>Interface states that explain themselves.</h1>
            <p>
              Shared patterns stay consistent across organizer, reviewer,
              speaker, and public workflows.
            </p>
          </div>
          <a className="fixture-back" href="/">
            Return to workspace
          </a>
        </header>

        <nav className="fixture-tabs" aria-label="Fixture state">
          {fixtureStates.map((state) => (
            <a
              aria-current={state === fixtureState ? "page" : undefined}
              href={`/fixtures/ui?state=${state}`}
              key={state}
            >
              {state}
            </a>
          ))}
        </nav>

        <section className="fixture-section" aria-labelledby="state-title">
          <div className="fixture-section-heading">
            <div>
              <p className="overline">Page state</p>
              <h2 id="state-title">{fixtureState} fixture</h2>
            </div>
            <span>Responsive table → named cards at 360px</span>
          </div>
          <FixtureStateView state={fixtureState} />
        </section>

        <div className="fixture-grid">
          <Card>
            <p className="overline">Fields and errors</p>
            <h2>Validation stays close and summarized.</h2>
            <ErrorSummary
              errors={[
                {
                  fieldId: "fixture-reply-to",
                  message: "Enter a valid reply-to email address",
                },
              ]}
            />
            <TextField
              description="Replies from speakers are sent here."
              error="Enter an address in the format name@example.com."
              id="fixture-reply-to"
              label="Reply-to email"
              required
              type="email"
              defaultValue="hello@"
            />
          </Card>

          <Card>
            <p className="overline">Overlays and feedback</p>
            <h2>Focus is trapped, restored, and announced.</h2>
            <p className="fixture-copy">
              Escape closes overlays. Toasts acknowledge completion while
              durable errors remain in the page.
            </p>
            <div className="fixture-actions">
              <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
              <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
                Open drawer
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setToasts([
                    {
                      id: "fixture-toast",
                      title: "Draft saved",
                      message: "All changes are available from this event.",
                      tone: "success",
                    },
                  ]);
                }}
              >
                Show toast
              </Button>
            </div>
          </Card>
        </div>
      </div>

      <Dialog
        description="Keyboard focus remains here until the dialog closes."
        onClose={closeDialog}
        open={dialogOpen}
        title="Publish this form version?"
      >
        <TextField label="Confirmation note" defaultValue="Ready for review" />
        <div className="fixture-dialog-actions">
          <Button variant="secondary" onClick={closeDialog}>
            Keep editing
          </Button>
          <Button onClick={closeDialog}>Publish version</Button>
        </div>
      </Dialog>

      <Drawer
        description="Use this pattern for narrow-screen navigation and contextual detail."
        onClose={closeDrawer}
        open={drawerOpen}
        title="Speaker details"
      >
        <p className="fixture-copy">
          Mina has completed three of four required assignments. Her headshot is
          due August 11.
        </p>
        <Button onClick={closeDrawer}>View profile</Button>
      </Drawer>

      <ConfirmDialog
        confirmLabel="Reset demo"
        description="Only this synthetic fixture is affected. Production event data is never included."
        onClose={closeConfirm}
        onConfirm={() => {
          closeConfirm();
          setToasts([
            {
              id: "fixture-reset",
              title: "Demo reset",
              message: "The synthetic fixture returned to its initial state.",
              tone: "success",
            },
          ]);
        }}
        open={confirmOpen}
        title="Reset this demo fixture?"
      />

      <ToastRegion
        messages={toasts}
        onDismiss={(id) => {
          setToasts((current) => current.filter((toast) => toast.id !== id));
        }}
      />
    </main>
  );
}
