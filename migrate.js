import 'dotenv/config';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import Restaurant from './models/Restaurant.js';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/breakfast-ordering';
const DATA_FILE = path.join(process.cwd(), 'data', 'restaurants.json');

async function migrate() {
  console.log('🔄 Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected');

  if (!fs.existsSync(DATA_FILE)) {
    console.log('⚠️  No restaurants.json found. Nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  console.log(`📦 Found ${data.length} restaurant(s) in restaurants.json`);

  let inserted = 0;
  let skipped = 0;

  for (const r of data) {
    const exists = await Restaurant.findOne({ id: r.id });
    if (exists) {
      console.log(`  ⏭️  Skipping "${r.name}" (id: ${r.id}) — already exists`);
      skipped++;
      continue;
    }

    await Restaurant.create({
      id: r.id,
      name: r.name,
      address: r.address || '',
      googleMapsUrl: r.googleMapsUrl || '',
      phone: r.phone || '',
      menuImages: r.menuImages || [],
      menuItems: r.menuItems || [],
      createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
    });
    console.log(`  ✅ Migrated "${r.name}" (${r.menuItems?.length || 0} menu items)`);
    inserted++;
  }

  console.log(`\n🎉 Migration complete: ${inserted} inserted, ${skipped} skipped`);
  await mongoose.disconnect();
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
