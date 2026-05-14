import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TEMPLATE_CODE = 'GOLEBICA'
const TEMPLATE_ID = 'cmmzx2rch0001qe203bmpdbcc'
const LEFT_INTRO_FIELD_KEY = 'field_1774081213835'
const NAME_FIELD_KEY = 'field_1774081186281'

type FieldInput = {
  key: string
  label: string
  type: string
  required: boolean
  sortOrder: number
  placeholder?: string | null
  defaultValue?: string | null
  optionsJson?: string[] | null
  helpText?: string | null
}

const desiredFields: FieldInput[] = [
  {
    key: NAME_FIELD_KEY,
    label: 'Imię',
    type: 'text',
    required: true,
    sortOrder: 1,
    placeholder: 'np. Zosia',
  },
  {
    key: LEFT_INTRO_FIELD_KEY,
    label: 'Wraz z...',
    type: 'radio',
    required: true,
    sortOrder: 2,
    optionsJson: [
      'wraz z Rodzicami pragnie zaprosić',
      'z Mamą pragnie zaprosić',
      'z Tatą pragnie zaprosić',
      'z Rodziną pragnie zaprosić',
      'wraz z Rodzicami pragną zaprosić',
    ],
  },
  {
    key: 'guest_list',
    label: 'Lista gości',
    type: 'textarea',
    required: true,
    sortOrder: 3,
    placeholder: 'np. Babcię i Dziadka\nCiocię Anię z rodziną',
  },
  {
    key: 'sacrament_name',
    label: 'Sakrament',
    type: 'text',
    required: true,
    sortOrder: 4,
    placeholder: 'np. Sakramentu Pierwszej Komunii Świętej',
    defaultValue: 'Sakramentu Pierwszej Komunii Świętej',
  },
  {
    key: 'ceremony_details',
    label: 'Data i godzina',
    type: 'textarea',
    required: true,
    sortOrder: 5,
    placeholder: 'np. 15 maja 2026 r.\no godzinie 12:00',
  },
  {
    key: 'church_details',
    label: 'Kościół',
    type: 'textarea',
    required: true,
    sortOrder: 6,
    placeholder: 'np. w Kościele św. Anny w Krakowie',
  },
  {
    key: 'right_greeting',
    label: 'Zwrot powitalny',
    type: 'text',
    required: true,
    sortOrder: 7,
    placeholder: 'np. Kochani',
    defaultValue: 'Kochani',
  },
  {
    key: 'reception_text',
    label: 'Treść zaproszenia na przyjęcie',
    type: 'textarea',
    required: true,
    sortOrder: 8,
    placeholder: 'np. Po uroczystości serdecznie zapraszamy na przyjęcie...',
  },
  {
    key: 'confirmation_text',
    label: 'Tekst potwierdzenia',
    type: 'textarea',
    required: true,
    sortOrder: 9,
    placeholder: 'np. Uprzejmie prosimy o potwierdzenie przybycia...',
  },
]

function textboxLayer(input: {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  text: string
  fieldKey?: string
  fontFamily: string
  fontSize: number
  fontWeight?: number
  fontStyle?: 'normal' | 'italic'
  lineHeight?: number
}) {
  return {
    id: input.id,
    name: input.name,
    type: 'textbox' as const,
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: input.zIndex,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    rotation: 0,
    properties: {
      type: 'textbox' as const,
      text: input.text,
      fieldKey: input.fieldKey ?? '',
      fontSize: input.fontSize,
      fontUnit: 'pt' as const,
      fontFamily: input.fontFamily,
      fontWeight: input.fontWeight ?? 400,
      fontStyle: input.fontStyle ?? 'normal',
      fill: '#222222',
      textAlign: 'center' as const,
      verticalAlign: 'middle' as const,
      lineHeight: input.lineHeight ?? 1.15,
      padding: 0,
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      borderWidth: 0,
      editable: true,
      clientDraggable: false,
      clientResizable: false,
      clientRotatable: false,
    },
  }
}

function staticTextLayer(input: {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  text: string
  fontFamily: string
  fontSize: number
  fontWeight?: number
  fontStyle?: 'normal' | 'italic'
  lineHeight?: number
}) {
  return {
    id: input.id,
    name: input.name,
    type: 'static_text' as const,
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: input.zIndex,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    rotation: 0,
    properties: {
      type: 'static_text' as const,
      text: input.text,
      fontSize: input.fontSize,
      fontUnit: 'pt' as const,
      fontFamily: input.fontFamily,
      fontWeight: input.fontWeight ?? 400,
      fontStyle: input.fontStyle ?? 'normal',
      fill: '#222222',
      textAlign: 'center' as const,
      lineHeight: input.lineHeight ?? 1.15,
      editable: false as const,
    },
  }
}

function imageLayer(input: {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  imageUrl: string
}) {
  return {
    id: input.id,
    name: input.name,
    type: 'image' as const,
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: input.zIndex,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    rotation: 0,
    properties: {
      type: 'image' as const,
      imageUrl: input.imageUrl,
      fit: 'contain' as const,
    },
  }
}

const layoutJson = {
  version: 1,
  canvas: {
    width: 3508,
    height: 2481,
    unit: 'px',
    dpi: 300,
    bleed: 0,
    safeArea: 0,
    backgroundColor: '#ffffff',
  },
  fonts: [
    { family: 'Mea Culpa', weight: 400, style: 'normal' },
    { family: 'Cormorant Garamond', weight: 400, style: 'normal' },
    { family: 'Cormorant Garamond', weight: 600, style: 'normal' },
    { family: 'Cormorant Garamond', weight: 400, style: 'italic' },
  ],
  layers: [
    {
      id: 'bg_golebica',
      name: 'Tło',
      type: 'background' as const,
      visible: true,
      locked: true,
      opacity: 1,
      zIndex: 0,
      x: 1754,
      y: 1240.5,
      width: 3508,
      height: 2481,
      rotation: 0,
      properties: {
        type: 'background' as const,
        imageUrl: 'templates/GOLEBICA/background/eleganckie-golebica-komunia_1774073325557.png',
        fit: 'cover' as const,
      },
    },
    imageLayer({
      id: 'left_wreath',
      name: 'Wieniec',
      x: 901,
      y: 618,
      width: 430,
      height: 396,
      zIndex: 1,
      imageUrl: 'templates/GOLEBICA/background/serce_1774100316776.svg',
    }),
    textboxLayer({
      id: 'left_name',
      name: 'Imię',
      x: 900,
      y: 882,
      width: 1180,
      height: 168,
      zIndex: 2,
      text: '<imię>',
      fieldKey: NAME_FIELD_KEY,
      fontFamily: 'Mea Culpa',
      fontSize: 28,
      lineHeight: 1.08,
    }),
    textboxLayer({
      id: 'left_intro',
      name: 'Wraz z...',
      x: 900,
      y: 1070,
      width: 1180,
      height: 62,
      zIndex: 3,
      text: '<wraz z>',
      fieldKey: LEFT_INTRO_FIELD_KEY,
      fontFamily: 'Cormorant Garamond',
      fontSize: 13,
      lineHeight: 1.1,
    }),
    textboxLayer({
      id: 'left_guests',
      name: 'Lista gości',
      x: 900,
      y: 1280,
      width: 1180,
      height: 132,
      zIndex: 4,
      text: '<lista>',
      fieldKey: 'guest_list',
      fontFamily: 'Cormorant Garamond',
      fontSize: 18,
      fontWeight: 600,
      lineHeight: 1.2,
    }),
    staticTextLayer({
      id: 'left_occasion_static',
      name: 'Okazja',
      x: 900,
      y: 1488,
      width: 1180,
      height: 44,
      zIndex: 5,
      text: 'na uroczystość przyjęcia',
      fontFamily: 'Cormorant Garamond',
      fontSize: 13,
      lineHeight: 1.1,
    }),
    textboxLayer({
      id: 'left_sacrament',
      name: 'Sakrament',
      x: 900,
      y: 1648,
      width: 1180,
      height: 82,
      zIndex: 6,
      text: '<sakrament>',
      fieldKey: 'sacrament_name',
      fontFamily: 'Cormorant Garamond',
      fontSize: 17,
      fontWeight: 600,
      lineHeight: 1.12,
    }),
    staticTextLayer({
      id: 'left_when_static',
      name: 'Która odbędzie się',
      x: 900,
      y: 1768,
      width: 1180,
      height: 40,
      zIndex: 7,
      text: 'która odbędzie się',
      fontFamily: 'Cormorant Garamond',
      fontSize: 12,
      fontStyle: 'italic',
      lineHeight: 1.1,
    }),
    textboxLayer({
      id: 'left_date',
      name: 'Data i godzina',
      x: 900,
      y: 1898,
      width: 1180,
      height: 76,
      zIndex: 8,
      text: '<data>',
      fieldKey: 'ceremony_details',
      fontFamily: 'Cormorant Garamond',
      fontSize: 13,
      lineHeight: 1.18,
    }),
    textboxLayer({
      id: 'left_church',
      name: 'Kościół',
      x: 900,
      y: 2042,
      width: 1180,
      height: 110,
      zIndex: 9,
      text: '<kościół>',
      fieldKey: 'church_details',
      fontFamily: 'Cormorant Garamond',
      fontSize: 13,
      lineHeight: 1.18,
    }),
    textboxLayer({
      id: 'right_greeting',
      name: 'Zwrot powitalny',
      x: 2618,
      y: 782,
      width: 1200,
      height: 170,
      zIndex: 10,
      text: '<zwrot>',
      fieldKey: 'right_greeting',
      fontFamily: 'Mea Culpa',
      fontSize: 27,
      lineHeight: 1.08,
    }),
    textboxLayer({
      id: 'right_reception',
      name: 'Przyjęcie',
      x: 2618,
      y: 1310,
      width: 1200,
      height: 220,
      zIndex: 11,
      text: '<przyjęcie>',
      fieldKey: 'reception_text',
      fontFamily: 'Cormorant Garamond',
      fontSize: 13,
      lineHeight: 1.25,
    }),
    textboxLayer({
      id: 'right_confirmation',
      name: 'Potwierdzenie',
      x: 2618,
      y: 1718,
      width: 1200,
      height: 156,
      zIndex: 12,
      text: '<potwierdzenie>',
      fieldKey: 'confirmation_text',
      fontFamily: 'Cormorant Garamond',
      fontSize: 12,
      lineHeight: 1.22,
    }),
    staticTextLayer({
      id: 'right_goodbye',
      name: 'Pożegnanie',
      x: 2618,
      y: 2058,
      width: 1200,
      height: 70,
      zIndex: 13,
      text: 'Do zobaczenia !',
      fontFamily: 'Mea Culpa',
      fontSize: 18,
      lineHeight: 1.05,
    }),
  ],
}

async function main() {
  const template = await prisma.personalizationTemplate.findFirst({
    where: {
      OR: [{ id: TEMPLATE_ID }, { code: TEMPLATE_CODE }],
    },
    include: {
      forms: {
        include: {
          fields: true,
        },
        orderBy: {
          sortOrder: 'asc',
        },
      },
    },
  })

  if (!template) {
    throw new Error(`Template ${TEMPLATE_CODE} not found`)
  }

  const form =
    template.forms[0] ??
    (await prisma.form.create({
      data: {
        templateId: template.id,
        name: 'Gołębica',
        sortOrder: 0,
        isActive: true,
      },
    }))

  await prisma.form.update({
    where: { id: form.id },
    data: {
      name: 'Gołębica',
      sortOrder: 0,
      isActive: true,
    },
  })

  const existingFields = await prisma.formField.findMany({
    where: { formId: form.id },
  })
  const existingByKey = new Map(existingFields.map((field) => [field.key, field]))

  for (const field of desiredFields) {
    const existing = existingByKey.get(field.key)

    if (existing) {
      await prisma.formField.update({
        where: { id: existing.id },
        data: {
          label: field.label,
          type: field.type,
          required: field.required,
          sortOrder: field.sortOrder,
          placeholder: field.placeholder ?? null,
          defaultValue: field.defaultValue ?? null,
          optionsJson: field.optionsJson ?? null,
          helpText: field.helpText ?? null,
          minLength: null,
          maxLength: null,
          pattern: null,
          repeaterGroupKey: null,
          validationRulesJson: null,
        },
      })
      continue
    }

    await prisma.formField.create({
      data: {
        formId: form.id,
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required,
        sortOrder: field.sortOrder,
        placeholder: field.placeholder ?? null,
        defaultValue: field.defaultValue ?? null,
        optionsJson: field.optionsJson ?? null,
        helpText: field.helpText ?? null,
      },
    })
  }

  const desiredKeys = new Set(desiredFields.map((field) => field.key))
  const obsoleteFields = existingFields.filter((field) => !desiredKeys.has(field.key))
  if (obsoleteFields.length > 0) {
    await prisma.formField.deleteMany({
      where: {
        id: {
          in: obsoleteFields.map((field) => field.id),
        },
      },
    })
  }

  await prisma.personalizationTemplate.update({
    where: { id: template.id },
    data: {
      name: 'Gołębica',
      description: 'Dwustronne zaproszenie komunijne z gołębicą i wieńcem',
      layoutJson: layoutJson as any,
    },
  })

  const updated = await prisma.personalizationTemplate.findUnique({
    where: { id: template.id },
    include: {
      forms: {
        include: {
          fields: {
            orderBy: {
              sortOrder: 'asc',
            },
          },
        },
      },
    },
  })

  console.log(
    JSON.stringify(
      {
        templateId: updated?.id,
        templateCode: updated?.code,
        templateName: updated?.name,
        fields: updated?.forms[0]?.fields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          sortOrder: field.sortOrder,
        })),
        layers: (updated?.layoutJson as any)?.layers?.map((layer: any) => ({
          id: layer.id,
          name: layer.name,
          type: layer.type,
        })),
      },
      null,
      2
    )
  )
}

main()
  .catch(async (error) => {
    console.error(error)
    await prisma.$disconnect()
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
