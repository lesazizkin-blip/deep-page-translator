// Реестр провайдеров. Чтобы добавить новый — унаследуйтесь от Provider
// (base.js) и зарегистрируйте экземпляр здесь.

import { GoogleProvider } from './google.js';
import { DeepLProvider } from './deepl.js';
import { LibreProvider } from './libre.js';
import { BuiltinProvider } from './builtin.js';

const registry = new Map(
  [new GoogleProvider(), new BuiltinProvider(), new DeepLProvider(), new LibreProvider()].map((p) => [p.id, p])
);

export function getProvider(id) {
  return registry.get(id) || registry.get('google');
}
