import db from "../src/inc/sql.mjs";

const SETTINGS = [
  { key: 'motd', value: 'Hello World!' },
  { key: 'manual_approval', value: 'false' },
  { key: 'min_tags', value: '0' },
  { key: 'registration_open', value: 'true' }, // this means open reg with email, false would mean open reg with invite token
  { key: 'trusted_uploads', value: '3' },
  { key: 'about_text', value: '' },
  { key: 'rules_text', value: '' },
  { key: 'terms_text', value: '' }
];

const TAGS = [
  { id: 1, tag: 'sfw', normalized: 'sfw' },
  { id: 2, tag: 'nsfw', normalized: 'nsfw' },
  { id: 3, tag: 'nsfp', normalized: 'nsfp' },
  { id: 4, tag: 'nsfl', normalized: 'nsfl' }
];

async function seed() {
  console.log('--- Starting Database Seed ---');

  // Seed Site Settings
  console.log('Seeding site_settings...');
  for (const setting of SETTINGS) {
    await db`
      INSERT INTO site_settings (key, value)
      VALUES (${setting.key}, ${setting.value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
    console.log(`  Set ${setting.key} = ${setting.value.substring(0, 30)}${setting.value.length > 30 ? '...' : ''}`);
  }

  // Seed Tags
  console.log('Seeding tags...');
  for (const tag of TAGS) {
    if (tag.id) {
      // For protected tags with specific IDs, we use the ID
      await db`
        INSERT INTO tags (id, tag, normalized)
        VALUES (${tag.id}, ${tag.tag}, ${tag.normalized})
        ON CONFLICT (id) DO UPDATE SET tag = EXCLUDED.tag, normalized = EXCLUDED.normalized
      `;
      // Also ensure sequence is updated if we inserted specific IDs
      await db`SELECT setval('tags_id_seq', (SELECT MAX(id) FROM tags))`;
    } else {
      await db`
        INSERT INTO tags (tag, normalized)
        VALUES (${tag.tag}, ${tag.normalized})
        ON CONFLICT (tag) DO NOTHING
      `;
    }
    console.log(`  Tag: ${tag.tag}`);
  }

  console.log('--- Seed Completed Successfully ---');
  process.exit(0);
}

seed().catch(err => {
  console.error('--- Seed Failed ---');
  console.error(err);
  process.exit(1);
});
