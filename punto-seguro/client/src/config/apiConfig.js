/**
 * Configuración centralizada del acceso a la API.
 * Todo servicio del frontend debe leer la URL base de aquí, nunca hardcodearla.
 */
export const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || '/punto-seguro/api';
