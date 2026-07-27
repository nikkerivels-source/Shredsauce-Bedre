/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Hosted checkout for the Season One pass — a Stripe Payment Link, Paddle
   * checkout, or anything else that takes a return URL. Left unset in this
   * build, which is why the pass screen says payment is not connected.
   */
  readonly VITE_CHECKOUT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
