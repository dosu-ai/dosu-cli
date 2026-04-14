/**
 * Type shims for cross-repo @dosu/api type resolution.
 * Will be replaced by @dosu/api-types npm package once published.
 */

// Stub module declaration for CI where the main project is not available.
// Locally, tsconfig paths mapping resolves to the real AppRouter type.
// When @dosu/api-types is published, remove this and import from the package.
declare module "@dosu/api/root" {
  // biome-ignore lint/suspicious/noExplicitAny: stub until real types available
  export type AppRouter = any;
}

// Global type from @dosu/core/types/core.d.ts
declare type Nullable<T> = T | null | undefined;

// Email template type from @dosu/api/emails
declare type EmailFC<P = Record<string, unknown>> = React.FC<P> & {
  PreviewProps?: P;
};
