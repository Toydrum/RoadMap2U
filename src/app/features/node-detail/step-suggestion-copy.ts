import type { Lang } from '../../core/db/schema';

const ES = {
  title: 'Sugerir pasitos',
  disclosure: 'Al elegir Generar, estos títulos se envían a Amazon Bedrock para sugerir tres pasitos. Usa un árbol de prueba.',
  tree: 'Árbol',
  branch: 'Rama',
  ancestors: 'Ruta de la rama',
  existing: 'Pasito existente',
  generate: 'Generar',
  loading: 'Preparando sugerencias…',
  instructions: 'Puedes editar los pasitos y elegir cuáles guardar.',
  edit: 'Título del pasito {number}',
  select: 'Incluir el pasito {number}',
  save: 'Guardar selección',
  invalid: 'Cada pasito elegido necesita un título distinto de los demás y de los que ya existen en la rama.',
  unavailable: 'Las sugerencias no están disponibles por ahora. Puedes desmenuzar la rama a tu ritmo.',
  limit: 'Llegaste al límite de sugerencias. El cupo se renueva a las {time} (hora local).',
};

export const STEP_SUGGESTION_COPY = {
  es: ES,
  en: {
    title: 'Suggest little steps',
    disclosure: 'Choose Generate to send these titles to Amazon Bedrock for three suggestions. Use a test tree.',
    tree: 'Tree',
    branch: 'Branch',
    ancestors: 'Branch path',
    existing: 'Existing step',
    generate: 'Generate',
    loading: 'Getting suggestions…',
    instructions: 'You can edit the steps and choose which ones to save.',
    edit: 'Title of step {number}',
    select: 'Include step {number}',
    save: 'Save selected steps',
    invalid: 'Each selected step needs a title that differs from the other steps and any step already in the branch.',
    unavailable: 'Suggestions are unavailable for now. You can break down the branch at your own pace.',
    limit: 'You reached the suggestion limit. It resets at {time} (local time).',
  },
} satisfies Record<Lang, typeof ES>;
