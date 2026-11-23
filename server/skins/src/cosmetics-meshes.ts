/**
 * Меш-косметика: 3D-модели вместо кубов. СГЕНЕРИРОВАНО tools/cosmetics-import — не править руками,
 * меняйте конфиги в tools/cosmetics-import/items и запускайте импорт заново.
 *
 * Файлы моделей — server/skins/assets/cosmetics/<id>/. Новые мод и лаунчер рисуют meshes,
 * старые их не знают и рисуют кубы из parts.
 */
import type { MeshItem } from './cosmetics.ts'

export const MESH_ITEMS: MeshItem[] = [
  {
    "id": "backpack",
    "credit": {
      "title": "Hiking Backpack",
      "author": "Flok_",
      "url": "https://sketchfab.com/3d-models/a49cffb713294180ae9005309922e969",
      "license": "CC BY 4.0"
    },
    "meshes": [
      {
        "bone": "body",
        "pivot": [
          0,
          5,
          2.1
        ],
        "mesh": "cosmetics/backpack/mesh.json"
      }
    ]
  },
  {
    "id": "cat_ears",
    "name": "Лисьи ушки",
    "credit": {
      "title": "Accessory Fox Ears",
      "author": "state_L",
      "url": "https://sketchfab.com/3d-models/82f5a2d637cd462795ca33168f2fe1b0",
      "license": "CC BY 4.0"
    },
    "meshes": [
      {
        "bone": "head",
        "pivot": [
          0,
          -8,
          0
        ],
        "mesh": "cosmetics/cat_ears/mesh.json"
      }
    ]
  },
  {
    "id": "crown",
    "credit": {
      "title": "Minecraft Crown",
      "author": "Olaf4549",
      "url": "https://sketchfab.com/3d-models/88db58200f4d44798adb49a9b48a5579",
      "license": "CC BY 4.0"
    },
    "meshes": [
      {
        "bone": "head",
        "pivot": [
          0,
          -6.9,
          0
        ],
        "mesh": "cosmetics/crown/mesh.json"
      }
    ]
  },
  {
    "id": "horns",
    "credit": {
      "title": "Horn Accessory",
      "author": "state_L",
      "url": "https://sketchfab.com/3d-models/4532c2f82f0d4760845c8fe4242e042c",
      "license": "CC BY 4.0"
    },
    "meshes": [
      {
        "bone": "head",
        "pivot": [
          0,
          -7.5,
          -0.5
        ],
        "mesh": "cosmetics/horns/mesh.json"
      }
    ]
  },
  {
    "id": "top_hat",
    "credit": {
      "title": "Voxel top hat",
      "author": "Rovani",
      "url": "https://sketchfab.com/3d-models/ea9a1d9276584ebda27f3db37fe9c52e",
      "license": "CC BY 4.0"
    },
    "meshes": [
      {
        "bone": "head",
        "pivot": [
          0,
          -8.3,
          0
        ],
        "mesh": "cosmetics/top_hat/mesh.json"
      }
    ]
  }
]
