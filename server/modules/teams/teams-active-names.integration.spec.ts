import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HttpException } from '@nestjs/common';
import { makeTeamFixture, teamErrorIs } from './team-test.fixture';

const options = { skip: !process.env.TEAM_TEST_DATABASE_URL };

function nameConflict(error: unknown): boolean {
    return error instanceof HttpException && error.getStatus() === 409 && teamErrorIs('TEAM_NAME_CONFLICT')(error);
}

test('concurrent creates reserve an active name per owner and replay successful receipts', options, async () => {
    const f = await makeTeamFixture();
    try {
        const requests = [{ requestKey: 'first', name: ' Core Team ' }, { requestKey: 'second', name: 'core team' }];
        const result = await Promise.allSettled(requests.map(request => f.service.create(f.owner, request)));
        const winners = result.flatMap((entry, index) => entry.status === 'fulfilled' ? [{ entry, index }] : []);
        assert.equal(winners.length, 1);
        const [{ entry, index }] = winners;
        const rejected = result[1 - index];
        assert.equal(rejected.status, 'rejected');
        assert.ok(nameConflict(rejected.reason));
        assert.deepEqual(await f.service.create(f.owner, requests[index]), entry.value);
        await assert.rejects(f.service.create(f.owner, { ...requests[index], name: 'Changed intent' }), teamErrorIs('TEAM_REQUEST_KEY_CONFLICT'));
        const corrected = await f.service.create(f.owner, { ...requests[1 - index], name: 'Renamed request' });
        assert.notEqual(corrected.id, entry.value.id);
        const otherOwner = await f.service.create(f.stranger, { requestKey: 'first', name: 'Core Team' });
        assert.notEqual(otherOwner.id, entry.value.id);
        assert.equal((await f.service.list(f.owner, {})).items.length, 2);
    } finally {
        await f.dispose();
    }
});

test('migration preserves legacy duplicates and a name is reusable after the last active team archives', options, async () => {
    const f = await makeTeamFixture();
    try {
        await f.client`DROP INDEX teams_active_owner_name_idx`;
        const request = { requestKey: 'original', name: 'Legacy Team' };
        const original = await f.service.create(f.owner, request);
        const legacy = await f.service.create(f.owner, { requestKey: 'legacy', name: 'Other legacy name' });
        await f.client`UPDATE teams SET name = ' legacy team ', display_json = display_json || '{"name":" legacy team "}'::jsonb WHERE id = ${legacy.id}`;
        const migration = readFileSync('scripts/db/71_team_active_names.sql', 'utf8');
        await f.client.unsafe(migration);
        await f.client.unsafe(migration);
        assert.equal((await f.service.detail(f.owner, legacy.id)).name, ' legacy team ');
        assert.deepEqual(await f.service.create(f.owner, request), original);

        const extra = await f.service.create(f.owner, { requestKey: 'extra', name: 'Extra' });
        await assert.rejects(f.service.save(f.owner, extra.id, 'display', {
            requestKey: 'rename', expectedDisplayRevision: extra.displayRevision, display: { ...extra.display, name: request.name },
        }), nameConflict);
        await f.service.save(f.owner, original.id, 'display', {
            requestKey: 'edit-avatar', expectedDisplayRevision: original.displayRevision, display: { ...original.display, avatar: 'fixture' },
        });

        for (const [index, team] of [original, legacy].entries()) {
            await assert.rejects(f.service.create(f.owner, { requestKey: 'replacement', name: request.name }), nameConflict);
            const preview = await f.versions.archivePreview(f.owner, team.id, {
                requestKey: 'preview-' + index, expectedBindingRevision: 0, expectedCurrentVersionId: null, executionChoice: 'pause_all',
            });
            await f.versions.archive(f.owner, team.id, {
                requestKey: 'archive-' + index, previewId: preview.previewId, previewHash: preview.previewHash,
            });
        }

        const replacement = await f.service.create(f.owner, { requestKey: 'replacement', name: request.name });
        assert.notEqual(replacement.id, original.id);
        assert.deepEqual(await f.service.create(f.owner, request), original);
        assert.equal((await f.service.detail(f.owner, original.id)).status, 'archived');
    } finally {
        await f.dispose();
    }
});
