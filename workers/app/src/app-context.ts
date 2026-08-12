export interface AppContext {
  Bindings: Env;
  Variables: {
    requestDatabase?: D1DatabaseSession;
    requestId: string;
  };
}
