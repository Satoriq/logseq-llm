import '@logseq/libs';
import { main } from './main';

logseq.ready(main).catch((err: unknown) => console.error('[logseq-ai] failed to start', err));
