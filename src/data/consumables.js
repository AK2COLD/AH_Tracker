/**
 * consumables.js — TBC Classic consumable data, spec-specific
 *
 * Each class/spec maps directly to its optimal consumable list so that
 * flask choices (e.g. Blinding Light vs Pure Death) are correct per spec
 * rather than listing all caster options at once.
 *
 * Item IDs verified against Wowhead TBC Classic.
 */

// ── Shared consumable definitions (reused across specs) ──────────────────

const FLASKS = {
    blinding_light:     { item_id: 33049, name: 'Flask of Blinding Light',      type: 'Flask',  note: '+80 arcane/holy/nature SP — BiS for arcane/nature casters' },
    pure_death:         { item_id: 22861, name: 'Flask of Pure Death',           type: 'Flask',  note: '+80 shadow/fire/frost SP — BiS for fire/frost/shadow casters' },
    relentless_assault: { item_id: 33092, name: 'Flask of Relentless Assault',   type: 'Flask',  note: '+120 AP — BiS physical DPS flask' },
    fortification:      { item_id: 33082, name: 'Flask of Fortification',        type: 'Flask',  note: '+500 max HP — main tank flask' },
    mighty_restoration: { item_id: 33926, name: 'Flask of Mighty Restoration',   type: 'Flask',  note: '+25 MP5 — healer flask' },
};

const ELIXIRS = {
    major_agility:      { item_id: 22831, name: 'Elixir of Major Agility',       type: 'Elixir', note: '+35 Agility — battle elixir for physical DPS' },
    mastery:            { item_id: 28103, name: 'Elixir of Mastery',             type: 'Elixir', note: '+15 all stats — guardian elixir' },
    major_firepower:    { item_id: 22827, name: 'Elixir of Major Firepower',     type: 'Elixir', note: '+55 fire SP — battle elixir for fire casters' },
    major_shadow:       { item_id: 22835, name: 'Elixir of Major Shadow Power',  type: 'Elixir', note: '+55 shadow SP — battle elixir for shadow casters' },
    major_frost:        { item_id: 22826, name: 'Elixir of Major Frost Power',   type: 'Elixir', note: '+35 frost SP — battle elixir for frost casters' },
    major_mageblood:    { item_id: 22840, name: 'Elixir of Major Mageblood',     type: 'Elixir', note: '+16 MP5 — guardian elixir for healers' },
    healing_power:      { item_id: 22833, name: 'Elixir of Healing Power',       type: 'Elixir', note: '+81 healing power — battle elixir for healers' },
    major_fortitude:    { item_id: 32062, name: 'Elixir of Major Fortitude',     type: 'Elixir', note: '+250 HP + 10 HP/5 — battle elixir for tanks' },
    draenic_wisdom:     { item_id: 32067, name: 'Elixir of Draenic Wisdom',      type: 'Elixir', note: '+30 INT, +20 SPI — guardian elixir for casters/healers' },
    adamantite:         { item_id: 32905, name: 'Adamantite Elixir',             type: 'Elixir', note: '+25 STR/AGI — optional battle elixir for threat' },
};

const POTIONS = {
    mana:               { item_id: 22832, name: 'Super Mana Potion',             type: 'Potion', note: 'Restores 1800–3000 mana' },
    healing:            { item_id: 22829, name: 'Super Healing Potion',          type: 'Potion', note: 'Restores 2800–4600 HP' },
    destruction:        { item_id: 22839, name: 'Destruction Potion',            type: 'Potion', note: '+120 SP or +1% crit for 15 sec — pre-pot burst' },
    haste:              { item_id: 22838, name: 'Haste Potion',                  type: 'Potion', note: '+400 haste rating for 15 sec' },
    ironshield:         { item_id: 22841, name: 'Ironshield Potion',             type: 'Potion', note: '+2500 armor for 30 sec' },
};

const OILS = {
    wizard:             { item_id: 20749, name: 'Brilliant Wizard Oil',          type: 'Oil',    note: '+36 SP, +14 spell crit — weapon enchant for casters' },
    mana_oil:           { item_id: 20748, name: 'Brilliant Mana Oil',            type: 'Oil',    note: '+12 MP5, +25 healing — weapon enchant for healers' },
};

const FOOD = {
    basilisk:           { item_id: 27664, name: 'Blackened Basilisk',            type: 'Food',   note: '+23 Spell Damage, +20 Stamina' },
    sporefish:          { item_id: 27854, name: 'Blackened Sporefish',           type: 'Food',   note: '+8 MP5, +20 Stamina — mana regen food' },
    warp_burger:        { item_id: 27655, name: 'Warp Burger',                   type: 'Food',   note: '+20 Agility, +20 Spirit' },
    hot_talbuk:         { item_id: 27658, name: 'Spicy Hot Talbuk',              type: 'Food',   note: '+20 Hit Rating, +20 Stamina' },
    crawdad:            { item_id: 27657, name: 'Spicy Crawdad',                 type: 'Food',   note: '+30 Stamina, +20 Spirit' },
};

const MISC = {
    nightmare_seed:     { item_id: 22791, name: 'Nightmare Seed',                type: 'Trinket', note: '+2000 HP on use' },
};

// ── Preset consumable lists by role/sub-role ─────────────────────────────

const ARCANE_CASTER = [
    FLASKS.blinding_light,
    POTIONS.destruction,
    POTIONS.mana,
    ELIXIRS.draenic_wisdom,
    OILS.wizard,
    FOOD.basilisk,
    FOOD.sporefish,
];

const FIRE_CASTER = [
    FLASKS.pure_death,
    POTIONS.destruction,
    POTIONS.mana,
    ELIXIRS.major_firepower,
    ELIXIRS.draenic_wisdom,
    OILS.wizard,
    FOOD.basilisk,
];

const FROST_CASTER = [
    FLASKS.pure_death,
    POTIONS.destruction,
    POTIONS.mana,
    ELIXIRS.major_frost,
    ELIXIRS.draenic_wisdom,
    OILS.wizard,
    FOOD.basilisk,
];

const SHADOW_CASTER = [
    FLASKS.pure_death,
    POTIONS.destruction,
    POTIONS.mana,
    ELIXIRS.major_shadow,
    ELIXIRS.draenic_wisdom,
    OILS.wizard,
    FOOD.basilisk,
];

const NATURE_CASTER = [
    FLASKS.blinding_light,
    POTIONS.destruction,
    POTIONS.mana,
    ELIXIRS.draenic_wisdom,
    OILS.wizard,
    FOOD.basilisk,
    FOOD.sporefish,
];

const PHYSICAL_DPS = [
    FLASKS.relentless_assault,
    ELIXIRS.major_agility,
    ELIXIRS.mastery,
    POTIONS.haste,
    POTIONS.destruction,
    FOOD.warp_burger,
    FOOD.hot_talbuk,
];

const HEALER = [
    FLASKS.mighty_restoration,
    POTIONS.mana,
    POTIONS.healing,
    ELIXIRS.healing_power,
    ELIXIRS.major_mageblood,
    OILS.mana_oil,
    FOOD.crawdad,
];

const TANK = [
    FLASKS.fortification,
    ELIXIRS.major_fortitude,
    ELIXIRS.adamantite,
    POTIONS.ironshield,
    POTIONS.healing,
    MISC.nightmare_seed,
    FOOD.crawdad,
];

// ── Spec → consumable list ───────────────────────────────────────────────

const CONSUMABLES_BY_SPEC = {
    // Druid
    'Druid/Balance':          ARCANE_CASTER,   // Moonfire/Starfire = arcane/nature
    'Druid/Feral Combat':     PHYSICAL_DPS,
    'Druid/Restoration':      HEALER,

    // Hunter (all specs — physical ranged)
    'Hunter/Beast Mastery':   PHYSICAL_DPS,
    'Hunter/Marksmanship':    PHYSICAL_DPS,
    'Hunter/Survival':        PHYSICAL_DPS,

    // Mage — flask choice differs by spell school
    'Mage/Arcane':            ARCANE_CASTER,   // Arcane school → Blinding Light
    'Mage/Fire':              FIRE_CASTER,     // Fire school → Pure Death
    'Mage/Frost':             FROST_CASTER,    // Frost school → Pure Death

    // Paladin
    'Paladin/Holy':           HEALER,
    'Paladin/Protection':     TANK,
    'Paladin/Retribution':    PHYSICAL_DPS,

    // Priest
    'Priest/Discipline':      HEALER,
    'Priest/Holy':            HEALER,
    'Priest/Shadow':          SHADOW_CASTER,   // Shadow school → Pure Death

    // Rogue
    'Rogue/Assassination':    PHYSICAL_DPS,
    'Rogue/Combat':           PHYSICAL_DPS,
    'Rogue/Subtlety':         PHYSICAL_DPS,

    // Shaman
    'Shaman/Elemental':       NATURE_CASTER,   // Lightning = nature → Blinding Light
    'Shaman/Enhancement':     PHYSICAL_DPS,
    'Shaman/Restoration':     HEALER,

    // Warlock
    'Warlock/Affliction':     SHADOW_CASTER,   // Shadow school → Pure Death
    'Warlock/Demonology':     SHADOW_CASTER,
    'Warlock/Destruction':    FIRE_CASTER,     // Fire school → Pure Death

    // Warrior
    'Warrior/Arms':           PHYSICAL_DPS,
    'Warrior/Fury':           PHYSICAL_DPS,
    'Warrior/Protection':     TANK,
};

// ── Role label for display ────────────────────────────────────────────────

const SPEC_ROLES = {
    'Druid/Balance':          'Balance Druid',
    'Druid/Feral Combat':     'Feral Druid',
    'Druid/Restoration':      'Resto Druid',
    'Hunter/Beast Mastery':   'BM Hunter',
    'Hunter/Marksmanship':    'MM Hunter',
    'Hunter/Survival':        'SV Hunter',
    'Mage/Arcane':            'Arcane Mage',
    'Mage/Fire':              'Fire Mage',
    'Mage/Frost':             'Frost Mage',
    'Paladin/Holy':           'Holy Paladin',
    'Paladin/Protection':     'Prot Paladin',
    'Paladin/Retribution':    'Ret Paladin',
    'Priest/Discipline':      'Disc Priest',
    'Priest/Holy':            'Holy Priest',
    'Priest/Shadow':          'Shadow Priest',
    'Rogue/Assassination':    'Assassin Rogue',
    'Rogue/Combat':           'Combat Rogue',
    'Rogue/Subtlety':         'Subtlety Rogue',
    'Shaman/Elemental':       'Elemental Shaman',
    'Shaman/Enhancement':     'Enhancement Shaman',
    'Shaman/Restoration':     'Resto Shaman',
    'Warlock/Affliction':     'Affliction Warlock',
    'Warlock/Demonology':     'Demonology Warlock',
    'Warlock/Destruction':    'Destruction Warlock',
    'Warrior/Arms':           'Arms Warrior',
    'Warrior/Fury':           'Fury Warrior',
    'Warrior/Protection':     'Prot Warrior',
};

export function getSpecRole(className, spec) {
    return SPEC_ROLES[`${className}/${spec}`] || null;
}

export function getConsumablesForSpec(className, spec) {
    return CONSUMABLES_BY_SPEC[`${className}/${spec}`] || [];
}
