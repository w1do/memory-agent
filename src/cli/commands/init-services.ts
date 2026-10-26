import { assertSharedServiceUp } from '../../global/shared-mode.js';

export async function prepareInitServices(): Promise<void> {
  await assertSharedServiceUp();
}
