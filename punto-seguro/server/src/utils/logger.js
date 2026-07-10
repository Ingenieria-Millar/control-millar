/**
 * Logger mínimo centralizado. Aísla el resto del código de `console.*`
 * para poder cambiar de proveedor (pino, winston, etc.) en un solo lugar.
 */
const timestamp = () => new Date().toISOString();

export const logger = {
  info: (...args) => console.log(`[INFO ${timestamp()}]`, ...args),
  warn: (...args) => console.warn(`[WARN ${timestamp()}]`, ...args),
  error: (...args) => console.error(`[ERROR ${timestamp()}]`, ...args),
  debug: (...args) => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[DEBUG ${timestamp()}]`, ...args);
    }
  },
};
