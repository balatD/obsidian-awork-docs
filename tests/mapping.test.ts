import { describe, expect, it } from 'vitest';
import { buildPathMap, defaultMappingOptions, sanitizeSegment } from '../src/core/mapping';
import type { RemoteDoc, RemoteSpace } from '../src/core/ports';

const spaces: RemoteSpace[] = [{ id: 's1', name: 'Engineering' }];

function doc(overrides: Partial<RemoteDoc> & { id: string; name: string }): RemoteDoc {
	return {
		scope: 'space',
		spaceId: 's1',
		parentId: null,
		emoji: null,
		updatedOn: '2026-08-24T10:00:00.000Z',
		...overrides,
	};
}

describe('sanitizeSegment', () => {
	it('replaces characters that break vault paths', () => {
		expect(sanitizeSegment('Q3/Q4: plan?')).toBe('Q3-Q4- plan-');
	});

	it('never yields an empty or dot-leading name', () => {
		expect(sanitizeSegment('   ')).toBe('Untitled');
		expect(sanitizeSegment('...hidden')).toBe('hidden');
	});

	it('caps runaway titles', () => {
		expect(sanitizeSegment('x'.repeat(400)).length).toBeLessThanOrEqual(120);
	});
});

describe('buildPathMap', () => {
	it('places space documents under the space folder', () => {
		const paths = buildPathMap([doc({ id: 'a', name: 'Runbook' })], spaces, defaultMappingOptions);
		expect(paths.get('a')).toBe('awork/Engineering/Runbook.md');
	});

	it('nests children below their parent as a folder note', () => {
		const paths = buildPathMap(
			[doc({ id: 'p', name: 'Handbook' }), doc({ id: 'c', name: 'Onboarding', parentId: 'p' })],
			spaces,
			defaultMappingOptions,
		);
		expect(paths.get('p')).toBe('awork/Engineering/Handbook.md');
		expect(paths.get('c')).toBe('awork/Engineering/Handbook/Onboarding.md');
	});

	it('anchors an orphan at the space root when its parent is out of scope', () => {
		const paths = buildPathMap([doc({ id: 'c', name: 'Orphan', parentId: 'missing' })], spaces, defaultMappingOptions);
		expect(paths.get('c')).toBe('awork/Engineering/Orphan.md');
	});

	it('survives a parent cycle instead of looping forever', () => {
		const paths = buildPathMap(
			[doc({ id: 'a', name: 'A', parentId: 'b' }), doc({ id: 'b', name: 'B', parentId: 'a' })],
			spaces,
			defaultMappingOptions,
		);
		expect(paths.get('a')).toBeDefined();
		expect(paths.get('b')).toBeDefined();
	});

	it('disambiguates documents that share a name', () => {
		const paths = buildPathMap(
			[doc({ id: 'a1', name: 'Notes' }), doc({ id: 'a2', name: 'Notes' })],
			spaces,
			defaultMappingOptions,
		);
		expect([...paths.values()].sort()).toEqual([
			'awork/Engineering/Notes (2).md',
			'awork/Engineering/Notes.md',
		]);
	});

	it('assigns collision suffixes deterministically across runs', () => {
		const docs = [doc({ id: 'a2', name: 'Notes' }), doc({ id: 'a1', name: 'Notes' })];
		const first = buildPathMap(docs, spaces, defaultMappingOptions);
		const second = buildPathMap([...docs].reverse(), spaces, defaultMappingOptions);
		expect(first.get('a1')).toBe(second.get('a1'));
	});

	it('separates private and shared documents', () => {
		const paths = buildPathMap(
			[
				doc({ id: 'p', name: 'Scratch', scope: 'private', spaceId: null }),
				doc({ id: 's', name: 'Plan', scope: 'shared', spaceId: null }),
			],
			spaces,
			defaultMappingOptions,
		);
		expect(paths.get('p')).toBe('awork/Private/Scratch.md');
		expect(paths.get('s')).toBe('awork/Shared with me/Plan.md');
	});
});
