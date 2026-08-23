// ============================================================
// Rate Limiter para la API de Riot Games
// ============================================================
//
// Limites de la personal key:
// - 20 requests por segundo
// - 100 requests cada 2 minutos
//
// Estrategia: ventana deslizante (sliding window).
// Guardamos el timestamp de cada request que hacemos.
// Antes de hacer un nuevo request, contamos cuantos hicimos
// en el ultimo segundo y en los ultimos 2 minutos.
// Si estamos cerca del limite, esperamos hasta que se libere espacio.
//
// Esto se ejecuta en memoria del servidor. En Vercel (serverless),
// cada invocacion puede ser una instancia nueva, asi que el array
// arranca vacio en cada cold start. Esto es OK porque el sync
// corre como un solo proceso (cron o manual).
// ============================================================

// Array donde guardamos el timestamp (en ms) de cada request
const requestTimestamps: number[] = [];

// Los dos limites que impone Riot
const LIMITS = {
  perSecond: { max: 20, windowMs: 1000 },         // 20 requests en 1 segundo
  perTwoMinutes: { max: 100, windowMs: 120_000 },  // 100 requests en 2 minutos
};

// Margen de seguridad: frenamos 2 requests ANTES del limite real.
// Asi evitamos que una race condition nos haga pasar el limite.
const SAFETY_BUFFER = 2;

// Cuenta cuantos requests hicimos dentro de una ventana de tiempo
function countRequestsInWindow(windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  return requestTimestamps.filter((t) => t > cutoff).length;
}

// Devuelve el timestamp mas viejo dentro de una ventana.
// Lo usamos para calcular CUANTO tenemos que esperar:
// si el request mas viejo en la ventana fue hace 1.8min,
// tenemos que esperar 0.2min para que salga de la ventana y se libere un slot.
function oldestTimestampInWindow(windowMs: number): number | null {
  const cutoff = Date.now() - windowMs;
  const inWindow = requestTimestamps.filter((t) => t > cutoff);
  return inWindow.length > 0 ? Math.min(...inWindow) : null;
}

// Limpia timestamps viejos que ya no entran en ninguna ventana.
// Sin esto el array creceria indefinidamente.
function cleanOldTimestamps(): void {
  const cutoff = Date.now() - LIMITS.perTwoMinutes.windowMs;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
  }
}

// Funcion principal: llamala ANTES de cada request a la API de Riot.
// Si estamos cerca del limite, espera automaticamente el tiempo necesario.
// Si no, pasa de largo sin esperar.
export async function waitForRateLimit(): Promise<void> {
  cleanOldTimestamps();

  // Primero checkeamos el limite de 2 minutos (es el mas restrictivo en practica).
  // Si hicimos 98+ requests en los ultimos 2 minutos, frenamos.
  const inTwoMin = countRequestsInWindow(LIMITS.perTwoMinutes.windowMs);
  if (inTwoMin >= LIMITS.perTwoMinutes.max - SAFETY_BUFFER) {
    const oldest = oldestTimestampInWindow(LIMITS.perTwoMinutes.windowMs);
    if (oldest) {
      // Esperamos hasta que el request mas viejo salga de la ventana de 2 min
      const waitMs = oldest + LIMITS.perTwoMinutes.windowMs - Date.now() + 100;
      if (waitMs > 0) {
        console.log(`[rate-limit] Limite de 2min alcanzado (${inTwoMin}/${LIMITS.perTwoMinutes.max}), esperando ${Math.ceil(waitMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  // Despues checkeamos el limite por segundo.
  // Si hicimos 18+ requests en el ultimo segundo, frenamos.
  const inSecond = countRequestsInWindow(LIMITS.perSecond.windowMs);
  if (inSecond >= LIMITS.perSecond.max - SAFETY_BUFFER) {
    const oldest = oldestTimestampInWindow(LIMITS.perSecond.windowMs);
    if (oldest) {
      const waitMs = oldest + LIMITS.perSecond.windowMs - Date.now() + 50;
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  // Registramos este request como "hecho" en este momento
  requestTimestamps.push(Date.now());
}
