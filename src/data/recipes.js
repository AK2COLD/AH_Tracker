/**
 * recipes.js — TBC Classic crafting recipes
 *
 * Ingredients are looked up BY NAME against the items table at query time,
 * so this file does not need hardcoded item IDs. The names must match the
 * in-game item names exactly as they appear in Auctionator / the items table.
 *
 * min_skill: the minimum profession skill required to craft the recipe.
 *   Used to filter recipes in the crafting widget based on character data
 *   exported by the in-game addon.
 *
 * Quantities, ingredients, and skill requirements sourced from Wowhead TBC Classic.
 * NOTE: Imbued Vial and Crystal Vial are vendor-bought reagents — their cost is
 * calculated using the vendor base price with a reputation discount applied.
 */

export const RECIPES = [

    // ── Alchemy: Flasks ──────────────────────────────────────────────────
    {
        profession:   'Alchemy',
        output_name:  'Flask of Blinding Light',
        min_skill:    350,
        materials: [
            { name: 'Felweed',       qty: 7 },
            { name: 'Netherbloom',   qty: 7 },
            { name: 'Imbued Vial',   qty: 1 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Flask of Pure Death',
        min_skill:    350,
        materials: [
            { name: 'Felweed',       qty: 7 },
            { name: 'Ragveil',       qty: 7 },
            { name: 'Ancient Lichen',qty: 7 },
            { name: 'Imbued Vial',   qty: 1 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Flask of Relentless Assault',
        min_skill:    350,
        materials: [
            { name: 'Felweed',        qty: 7 },
            { name: 'Dreaming Glory', qty: 7 },
            { name: 'Nightmare Vine', qty: 3 },
            { name: 'Imbued Vial',    qty: 1 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Flask of Fortification',
        min_skill:    350,
        materials: [
            { name: 'Felweed',        qty: 7 },
            { name: 'Ancient Lichen', qty: 7 },
            { name: 'Imbued Vial',    qty: 1 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Flask of Mighty Restoration',
        min_skill:    350,
        materials: [
            { name: 'Felweed',        qty: 7 },
            { name: 'Dreaming Glory', qty: 7 },
            { name: 'Imbued Vial',    qty: 1 },
        ],
    },

    // ── Alchemy: Transmutations ───────────────────────────────────────────
    // Meta gem transmutes — daily cooldown (or proc extra with Transmutation Mastery)
    {
        profession:   'Alchemy',
        output_name:  'Earthstorm Diamond',
        min_skill:    300,
        materials: [
            { name: 'Primal Earth',    qty: 2 },
            { name: 'Primal Water',    qty: 2 },
            { name: 'Golden Draenite', qty: 3 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Skyfire Diamond',
        min_skill:    300,
        materials: [
            { name: 'Flame Spessarite', qty: 3 },
            { name: 'Azure Moonstone',  qty: 3 },
            { name: 'Golden Draenite',  qty: 3 },
            { name: 'Primal Fire',      qty: 2 },
            { name: 'Primal Air',       qty: 2 },
        ],
    },
    // Primal Might — highly valuable, daily cooldown
    {
        profession:   'Alchemy',
        output_name:  'Primal Might',
        min_skill:    300,
        materials: [
            { name: 'Primal Air',   qty: 1 },
            { name: 'Primal Earth', qty: 1 },
            { name: 'Primal Fire',  qty: 1 },
            { name: 'Primal Mana',  qty: 1 },
            { name: 'Primal Water', qty: 1 },
        ],
    },
    // Primal element transmutes — 1:1 swaps, useful for arbitrage
    {
        profession:   'Alchemy',
        output_name:  'Primal Water',
        min_skill:    300,
        materials: [ { name: 'Primal Earth', qty: 1 } ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Primal Air',
        min_skill:    300,
        materials: [ { name: 'Primal Water', qty: 1 } ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Primal Fire',
        min_skill:    300,
        materials: [ { name: 'Primal Air', qty: 1 } ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Primal Earth',
        min_skill:    300,
        materials: [ { name: 'Primal Fire', qty: 1 } ],
    },

    // ── Alchemy: Potions ─────────────────────────────────────────────────
    {
        profession:   'Alchemy',
        output_name:  'Super Healing Potion',
        min_skill:    285,
        materials: [
            { name: 'Felweed',        qty: 2 },
            { name: 'Dreaming Glory', qty: 2 },
            { name: 'Crystal Vial',   qty: 1 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Super Mana Potion',
        min_skill:    300,
        materials: [
            { name: 'Felweed',        qty: 2 },
            { name: 'Ancient Lichen', qty: 2 },
            { name: 'Crystal Vial',   qty: 1 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Destruction Potion',
        min_skill:    325,
        materials: [
            { name: 'Nightmare Vine', qty: 2 },
            { name: 'Ragveil',        qty: 2 },
            { name: 'Crystal Vial',   qty: 1 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Haste Potion',
        min_skill:    300,
        materials: [
            { name: 'Felweed',        qty: 2 },
            { name: 'Ancient Lichen', qty: 2 },
            { name: 'Crystal Vial',   qty: 1 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Elixir of Major Agility',
        min_skill:    315,
        materials: [
            { name: 'Dreaming Glory', qty: 3 },
            { name: 'Felweed',        qty: 1 },
            { name: 'Crystal Vial',   qty: 1 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Elixir of Healing Power',
        min_skill:    315,
        materials: [
            { name: 'Dreaming Glory', qty: 3 },
            { name: 'Felweed',        qty: 1 },
            { name: 'Crystal Vial',   qty: 1 },
        ],
    },
    {
        profession:   'Alchemy',
        output_name:  'Elixir of Major Mageblood',
        min_skill:    340,
        materials: [
            { name: 'Mana Thistle',   qty: 4 },
            { name: 'Crystal Vial',   qty: 1 },
        ],
    },

    // ── Jewelcrafting: Rare gem cuts (1 raw gem → 1 cut gem) ─────────────
    // Living Ruby (red) cuts
    {
        profession:   'Jewelcrafting',
        output_name:  'Bold Living Ruby',
        min_skill:    340,
        materials: [ { name: 'Living Ruby', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Delicate Living Ruby',
        min_skill:    340,
        materials: [ { name: 'Living Ruby', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Runed Living Ruby',
        min_skill:    350,
        materials: [ { name: 'Living Ruby', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Teardrop Living Ruby',
        min_skill:    350,
        materials: [ { name: 'Living Ruby', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Subtle Living Ruby',
        min_skill:    340,
        materials: [ { name: 'Living Ruby', qty: 1 } ],
    },

    // Dawnstone (yellow) cuts
    {
        profession:   'Jewelcrafting',
        output_name:  'Brilliant Dawnstone',
        min_skill:    345,
        materials: [ { name: 'Dawnstone', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Smooth Dawnstone',
        min_skill:    345,
        materials: [ { name: 'Dawnstone', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Gleaming Dawnstone',
        min_skill:    350,
        materials: [ { name: 'Dawnstone', qty: 1 } ],
    },

    // Star of Elune (blue) cuts
    {
        profession:   'Jewelcrafting',
        output_name:  'Solid Star of Elune',
        min_skill:    345,
        materials: [ { name: 'Star of Elune', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Lustrous Star of Elune',
        min_skill:    345,
        materials: [ { name: 'Star of Elune', qty: 1 } ],
    },

    // Nightseye (purple) cuts
    {
        profession:   'Jewelcrafting',
        output_name:  'Royal Nightseye',
        min_skill:    350,
        materials: [ { name: 'Nightseye', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Shifting Nightseye',
        min_skill:    345,
        materials: [ { name: 'Nightseye', qty: 1 } ],
    },

    // Noble Topaz (orange) cuts
    {
        profession:   'Jewelcrafting',
        output_name:  'Potent Noble Topaz',
        min_skill:    350,
        materials: [ { name: 'Noble Topaz', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Glinting Noble Topaz',
        min_skill:    345,
        materials: [ { name: 'Noble Topaz', qty: 1 } ],
    },

    // Talasite (green) cuts
    {
        profession:   'Jewelcrafting',
        output_name:  'Radiant Talasite',
        min_skill:    335,
        materials: [ { name: 'Talasite', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Jagged Talasite',
        min_skill:    345,
        materials: [ { name: 'Talasite', qty: 1 } ],
    },

    // ── Jewelcrafting: Meta gem cuts ──────────────────────────────────────
    // Meta gems (Earthstorm/Skyfire Diamond) are cut from the raw meta gem only.
    {
        profession:   'Jewelcrafting',
        output_name:  'Bracing Earthstorm Diamond',
        min_skill:    360,
        materials: [ { name: 'Earthstorm Diamond', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Tenacious Earthstorm Diamond',
        min_skill:    360,
        materials: [ { name: 'Earthstorm Diamond', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Relentless Earthstorm Diamond',
        min_skill:    365,
        materials: [ { name: 'Earthstorm Diamond', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Mystical Skyfire Diamond',
        min_skill:    365,
        materials: [ { name: 'Skyfire Diamond', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Swift Skyfire Diamond',
        min_skill:    365,
        materials: [ { name: 'Skyfire Diamond', qty: 1 } ],
    },
    {
        profession:   'Jewelcrafting',
        output_name:  'Destructive Skyfire Diamond',
        min_skill:    370,
        materials: [ { name: 'Skyfire Diamond', qty: 1 } ],
    },

    // ── Cooking: Raid buff food ───────────────────────────────────────────
    {
        profession:   'Cooking',
        output_name:  'Blackened Basilisk',
        min_skill:    285,
        materials: [
            { name: 'Raw Basilisk Meat', qty: 1 },
        ],
    },
    {
        profession:   'Cooking',
        output_name:  'Warp Burger',
        min_skill:    275,
        materials: [
            { name: 'Warped Flesh',      qty: 1 },
        ],
    },
    {
        profession:   'Cooking',
        output_name:  'Spicy Hot Talbuk',
        min_skill:    325,
        materials: [
            { name: 'Talbuk Venison',    qty: 1 },
        ],
    },
    {
        profession:   'Cooking',
        output_name:  'Spicy Crawdad',
        min_skill:    375,
        materials: [
            { name: 'Furious Crawdad',   qty: 1 },
        ],
    },
    {
        profession:   'Cooking',
        output_name:  'Blackened Sporefish',
        min_skill:    300,
        materials: [
            { name: 'Zangarian Sporefish', qty: 1 },
        ],
    },
];
