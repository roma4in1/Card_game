// build-words.js — emits a flat words.json (~400 clue-friendly common words) for
// the Codenames 25-card grid. General vocabulary: concrete nouns, places, and a few
// well-known proper nouns that admit many clue associations. Single words only,
// uppercase-normalized for display.

const fs = require('fs');

const words = [
  // animals
  'CAT','DOG','HORSE','BEAR','LION','TIGER','SNAKE','EAGLE','SHARK','WHALE','DOLPHIN',
  'OCTOPUS','SPIDER','SCORPION','MOUSE','RAT','BAT','FOX','WOLF','DEER','MOLE','SEAL',
  'CRAB','FISH','DUCK','SWAN','OWL','CROW','DRAGON','HORN','TAIL','WING','PAW',
  // body
  'HEAD','HAND','FOOT','EYE','HEART','BONE','SKULL','BRAIN','TOOTH','HAIR','NAIL',
  // nature / geography
  'MOUNTAIN','RIVER','OCEAN','BEACH','DESERT','FOREST','JUNGLE','ISLAND','VOLCANO',
  'CAVE','CLIFF','VALLEY','GLACIER','WAVE','STORM','THUNDER','LIGHTNING','RAINBOW',
  'CLOUD','SNOW','ICE','FIRE','EARTH','MOON','STAR','SUN','SKY','WIND','ROCK','SAND',
  // places / structures
  'CASTLE','TOWER','BRIDGE','CHURCH','TEMPLE','PALACE','PYRAMID','THEATRE','SCHOOL',
  'HOSPITAL','PRISON','BANK','HOTEL','STADIUM','AIRPORT','STATION','HARBOUR','MARKET',
  'PARK','GARDEN','FARM','MILL','MINE','TUNNEL','WALL','GATE','DOOR','WINDOW','ROOF',
  // countries / world
  'ENGLAND','FRANCE','SPAIN','EGYPT','CHINA','INDIA','JAPAN','GREECE','ROME','MEXICO',
  'CANADA','BRAZIL','AFRICA','EUROPE','LONDON','PARIS','BERLIN','MOON','AMAZON',
  // transport
  'CAR','TRAIN','PLANE','SHIP','BOAT','ROCKET','TANK','TRUCK','BIKE','HORSE','SUBMARINE',
  'JET','SAIL','WHEEL','ENGINE','ANCHOR','COMPASS','MAP',
  // objects / tools
  'KNIFE','SWORD','SHIELD','SPEAR','BOW','ARROW','HAMMER','NAIL','SAW','DRILL','ROPE',
  'CHAIN','HOOK','NET','TRAP','KEY','LOCK','BELL','HORN','DRUM','PIANO','GUITAR',
  'VIOLIN','FLUTE','TRUMPET','BRUSH','PEN','PENCIL','BOOK','PAPER','INK','STAMP',
  'CLOCK','WATCH','GLASS','MIRROR','LAMP','CANDLE','TORCH','BATTERY','MAGNET','SPRING',
  'SCREEN','PHONE','CAMERA','ROBOT','LASER','BOMB','MISSILE','GUN','PISTON',
  // food / drink
  'BREAD','CHEESE','APPLE','ORANGE','LEMON','BANANA','GRAPE','CHERRY','BERRY','NUT',
  'EGG','MILK','HONEY','SUGAR','SALT','PEPPER','BUTTER','MEAT','FISH','RICE','BEAN',
  'CAKE','PIE','SOUP','TEA','COFFEE','WINE','BEER','WATER','ICE','CHOCOLATE',
  // people / roles
  'KING','QUEEN','KNIGHT','PRINCE','PRINCESS','WIZARD','WITCH','GHOST','GIANT','DWARF',
  'PIRATE','NINJA','SPY','SOLDIER','POLICE','DOCTOR','NURSE','TEACHER','JUDGE','THIEF',
  'KNIGHT','HUNTER','FARMER','SAILOR','PILOT','DRIVER','DANCER','SINGER','ACTOR','CLOWN',
  'ANGEL','DEVIL','SAINT','MONK','PRIEST','GENIUS','CHAMPION','HERO',
  // abstract / misc concrete
  'TIME','LIGHT','SHADOW','DREAM','LUCK','MAGIC','POWER','FORCE','SPEED','SOUND',
  'COLOUR','SHAPE','CIRCLE','SQUARE','LINE','POINT','CROSS','STAR','HEART','DIAMOND',
  'GOLD','SILVER','IRON','STEEL','COPPER','GLASS','STONE','WOOD','PLASTIC','RUBBER',
  'PAINT','THREAD','CLOTH','SILK','LEATHER','FUR','FEATHER','SCALE','SHELL',
  // sports / games
  'BALL','GOAL','RACE','MATCH','GAME','TEAM','COURT','FIELD','PITCH','RING','RACKET',
  'BAT','CLUB','PUCK','NET','MEDAL','TROPHY','CARD','DICE','CHESS','POKER',
  // seasons / time
  'SPRING','SUMMER','AUTUMN','WINTER','DAY','NIGHT','DAWN','DUSK','HOUR','WEEK','YEAR',
  // colours
  'RED','BLUE','GREEN','BLACK','WHITE','PURPLE','PINK','BROWN','GREY',
  // plants
  'TREE','FLOWER','ROSE','LEAF','ROOT','SEED','GRASS','BUSH','VINE','MOSS','FERN',
  'OAK','PINE','PALM','BAMBOO','CACTUS','MUSHROOM','WHEAT','CORN',
  // weather/elements extra + everyday
  'BANK','SPRING','BOND','BARK','BAT','CRANE','PITCH','SEAL','FILE','MATCH','PLATE',
  'TABLE','CHAIR','BED','SOFA','DESK','SHELF','BOX','BAG','BASKET','BOTTLE','CUP',
  'PLATE','BOWL','SPOON','FORK','POT','PAN','OVEN','FRIDGE','BROOM','SOAP','TOWEL',
];

// de-dupe (the list intentionally repeats a few ambiguous words like BANK/SPRING/PITCH
// that are great Codenames words; keep one of each) and validate single-word + caps.
const seen = new Set();
const clean = [];
for (const w of words) {
  const W = w.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(W)) { console.error('bad word:', w); continue; }
  if (seen.has(W)) continue;
  seen.add(W);
  clean.push(W);
}

console.log('unique words:', clean.length);
fs.writeFileSync('words.json', JSON.stringify(clean, null, 2));
console.log('wrote words.json');
