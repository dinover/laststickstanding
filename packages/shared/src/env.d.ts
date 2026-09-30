/* El paquete compartido no depende de DOM ni de Node; solo necesita esto del entorno. */
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
