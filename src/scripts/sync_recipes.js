import 'dotenv/config';
import { pool } from '../db.js';

const PROFESSIONS = [
    'Alchemy',
    'Blacksmithing',
    'Cooking',
    'Enchanting',
    'Engineering',
    'FirstAid',
    'Jewelcrafting',
    'Leatherworking',
    'Tailoring',
];

const DISPLAY_NAMES = {
    FirstAid: 'First Aid',
};

function getDisplayName(folder) {
    return DISPLAY_NAMES[folder] ?? folder;
}

function extractReagentsBlock(block) {
    // Find the start of "reagents = {"
    const startIdx = block.search(/reagents\s*=\s*\{/);
    if (startIdx === -1) return null;

    // Advance past "reagents = {"
    const braceStart = block.indexOf('{', startIdx + 'reagents'.length);
    if (braceStart === -1) return null;

    // Walk forward counting braces to find matching closing brace
    let depth = 0;
    let i = braceStart;
    for (; i < block.length; i++) {
        if (block[i] === '{') depth++;
        else if (block[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    // Return the content between the outer { and }
    return block.slice(braceStart + 1, i);
}

function parseRecipeBlock(block, profession) {
    const idMatch = block.match(/\bid\s*=\s*(\d+)/);
    const nameMatch = block.match(/\bname\s*=\s*"([^"]+)"/);
    const itemIdMatch = block.match(/\bitemId\s*=\s*(\d+)/);
    const skillMatch = block.match(/\bskillRequired\s*=\s*(\d+)/);

    if (!idMatch || !nameMatch || !itemIdMatch) return null;

    // Extract reagents block using brace-counting
    const reagentsText = extractReagentsBlock(block);
    if (!reagentsText) return null;

    const materials = [];
    const reagentPattern = /\{\s*itemId\s*=\s*\d+\s*,\s*name\s*=\s*"([^"]+)"\s*,\s*count\s*=\s*(\d+)\s*\}/g;
    let rm;
    while ((rm = reagentPattern.exec(reagentsText)) !== null) {
        materials.push({ name: rm[1], qty: parseInt(rm[2]) });
    }

    if (materials.length === 0) return null;

    return {
        recipe_id: parseInt(idMatch[1]),
        profession,
        recipe_name: nameMatch[1],
        output_item_id: parseInt(itemIdMatch[1]),
        output_name: nameMatch[1],
        output_qty: 1,
        min_skill: parseInt(skillMatch?.[1] ?? '0'),
        materials,
    };
}

function parseRecipes(lua, professionName) {
    const recipes = [];
    const lines = lua.split('\n');
    let inRecipe = false;
    let depth = 0;
    let currentBlock = '';

    for (const line of lines) {
        if (!inRecipe) {
            if (line.trim() === '{') {
                inRecipe = true;
                depth = 1;
                currentBlock = line + '\n';
            }
        } else {
            currentBlock += line + '\n';
            for (const ch of line) {
                if (ch === '{') depth++;
                else if (ch === '}') depth--;
            }
            if (depth === 0) {
                const recipe = parseRecipeBlock(currentBlock, professionName);
                if (recipe) recipes.push(recipe);
                inRecipe = false;
                currentBlock = '';
            }
        }
    }
    return recipes;
}

async function syncProfession(folder) {
    const displayName = getDisplayName(folder);
    const url = `https://raw.githubusercontent.com/kaldown/CraftLib/main/Data/TBC/${folder}/Recipes.lua`;

    const res = await fetch(url);
    if (!res.ok) {
        console.error(`[sync_recipes] Failed to fetch ${folder}: HTTP ${res.status}`);
        return 0;
    }

    const lua = await res.text();
    const recipes = parseRecipes(lua, displayName);

    for (const r of recipes) {
        await pool.query(
            `INSERT INTO recipe_catalog (recipe_id, profession, recipe_name, output_item_id, output_name, output_qty, min_skill, materials, synced_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
             ON CONFLICT (recipe_id) DO UPDATE SET
                 profession=EXCLUDED.profession, recipe_name=EXCLUDED.recipe_name,
                 output_item_id=EXCLUDED.output_item_id, output_name=EXCLUDED.output_name,
                 output_qty=EXCLUDED.output_qty, min_skill=EXCLUDED.min_skill,
                 materials=EXCLUDED.materials, synced_at=NOW()`,
            [r.recipe_id, r.profession, r.recipe_name, r.output_item_id, r.output_name, r.output_qty, r.min_skill, JSON.stringify(r.materials)]
        );
    }

    console.log(`[sync_recipes] ${displayName}: ${recipes.length} recipes`);
    return recipes.length;
}

async function main() {
    let total = 0;
    for (const folder of PROFESSIONS) {
        const count = await syncProfession(folder);
        total += count;
    }
    console.log(`[sync_recipes] Total: ${total} recipes`);

    // CraftLib stores the spell name in the `name` field for transmutes and
    // some other recipes, which lands in output_name incorrectly. Fix any row
    // where the items table has the actual item name for that output_item_id.
    const fix = await pool.query(`
        UPDATE recipe_catalog rc
        SET output_name = i.name
        FROM items i
        WHERE rc.output_item_id = i.item_id
          AND rc.output_name != i.name
    `);
    if (fix.rowCount > 0) {
        console.log(`[sync_recipes] Fixed output_name for ${fix.rowCount} recipes from items table`);
    }

    await pool.end();
}

main().catch((err) => {
    console.error('[sync_recipes] Fatal error:', err);
    process.exit(1);
});
