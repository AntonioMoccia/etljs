/**
 * Versione del protocollo dei plugin.
 *
 * Ogni plugin dichiara nel proprio manifest il protocollo per cui e' stato
 * compilato; il loader del core rifiuta i plugin con un protocollo diverso
 * invece di farli fallire piu' tardi, in mezzo a un run.
 *
 * Va incrementato SOLO quando cambia in modo incompatibile una delle firme
 * di questo pacchetto (Reader, Transformer, Writer, Ctx, Batch).
 */
export const PROTOCOL_VERSION = 1;
