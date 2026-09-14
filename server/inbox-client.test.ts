import assert from 'node:assert/strict';
import { test } from 'node:test';
import { preferredTaskDestination, type TaskDestination } from '../src/inbox-client.ts';

function destination(
  listId: string,
  area: TaskDestination['area'],
  options: { explicitMapping?: boolean; isFallback?: boolean } = {},
): TaskDestination {
  return {
    accountId: 'google-account',
    listId,
    listName: listId,
    area,
    explicitMapping: options.explicitMapping ?? false,
    isFallback: options.isFallback ?? false,
  };
}

test('task creation defaults only to a unique explicit area mapping or My Tasks', () => {
  const fallback = destination('my-tasks', 'Personal', { isFallback: true });
  const university = destination('university', 'University', { explicitMapping: true });
  const inferred = destination('inferred-work', 'Work');

  assert.equal(preferredTaskDestination([fallback, university, inferred], 'University')?.listId, 'university');
  assert.equal(preferredTaskDestination([fallback, university, inferred], 'Work')?.listId, 'my-tasks');
  assert.equal(preferredTaskDestination([university, inferred], 'Work'), null);
  assert.equal(preferredTaskDestination([
    university,
    destination('university-two', 'University', { explicitMapping: true }),
    fallback,
  ], 'University')?.listId, 'my-tasks');
});
