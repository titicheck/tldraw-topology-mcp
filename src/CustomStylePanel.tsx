import { Editor as TipTapEditor, type JSONContent } from '@tiptap/core'
import { useEffect, useState } from 'react'
import {
	DefaultColorStyle,
	DefaultFontStyle,
	DefaultStylePanel,
	StylePanelArrowheadPicker,
	StylePanelArrowKindPicker,
	StylePanelButtonPicker,
	StylePanelColorPicker,
	StylePanelDashPicker,
	StylePanelFillPicker,
	StylePanelFontPicker,
	StylePanelGeoShapePicker,
	StylePanelLabelAlignPicker,
	StylePanelOpacityPicker,
	StylePanelSection,
	StylePanelSizePicker,
	StylePanelSplinePicker,
	StylePanelTextAlignPicker,
	TldrawUiButtonIcon,
	TldrawUiToolbar,
	TldrawUiToolbarButton,
	getColorStyleItems,
	getTipTapDefaultExtensions,
	preventDefault,
	type Editor as TldrawEditor,
	type ReadonlySharedStyleMap,
	type StyleProp,
	type TLDefaultColorStyle,
	type TLRichText,
	type TLShape,
	type TLShapeId,
	type TLShapePartial,
	type TLUiIconType,
	type TLUiStylePanelProps,
	useEditor,
	useStylePanelContext,
	useTranslation,
	useValue,
} from 'tldraw'

type RichTextOperation = 'bold' | 'italic' | 'bulletList' | 'highlight'
type RichTextShape = TLShape & { props: TLShape['props'] & { richText: TLRichText } }

const RICH_TEXT_ACTIONS: Array<{
	operation: RichTextOperation
	icon: TLUiIconType
}> = [
	{ operation: 'bold', icon: 'bold' },
	{ operation: 'italic', icon: 'italic' },
	{ operation: 'bulletList', icon: 'bulletList' },
	{ operation: 'highlight', icon: 'highlight' },
]

function isRichTextShape(shape: TLShape | undefined): shape is RichTextShape {
	return !!shape && 'richText' in shape.props
}

function collectSelectedRichTextShapeIds(editor: TldrawEditor): TLShapeId[] {
	const selectedIds = editor.getSelectedShapeIds()
	if (selectedIds.length === 0) return []

	return [...editor.getShapeAndDescendantIds(selectedIds)].filter((id) =>
		isRichTextShape(editor.getShape(id)),
	)
}

function hasTextNode(node: any): boolean {
	if (!node) return false
	if (node.type === 'text' && typeof node.text === 'string' && node.text.length > 0) return true
	return Array.isArray(node.content) && node.content.some(hasTextNode)
}

function isUniformlyMarked(richText: TLRichText, markName: 'bold' | 'italic' | 'highlight') {
	let hasText = false
	let allMarked = true

	const visit = (node: any) => {
		if (node.type === 'text' && typeof node.text === 'string' && node.text.length > 0) {
			hasText = true
			if (!node.marks?.some((mark: any) => mark.type === markName)) {
				allMarked = false
			}
		}
		if (Array.isArray(node.content)) node.content.forEach(visit)
	}

	visit(richText)
	return hasText && allMarked
}

function isUniformlyBulletListed(richText: TLRichText) {
	const content = Array.isArray((richText as any).content) ? (richText as any).content : []
	const meaningfulBlocks = content.filter(hasTextNode)
	return meaningfulBlocks.length > 0 && meaningfulBlocks.every((node: any) => node.type === 'bulletList')
}

function isOperationActive(richText: TLRichText, operation: RichTextOperation) {
	switch (operation) {
		case 'bold':
		case 'italic':
		case 'highlight':
			return isUniformlyMarked(richText, operation)
		case 'bulletList':
			return isUniformlyBulletListed(richText)
	}
}

function transformWholeRichText(
	editor: TldrawEditor,
	richText: TLRichText,
	operation: RichTextOperation,
	active: boolean,
): TLRichText {
	const extensions = editor.getTextOptions().tipTapConfig?.extensions ?? getTipTapDefaultExtensions()
	const textEditor = new TipTapEditor({
		extensions,
		enableCoreExtensions: { textDirection: false },
		textDirection: 'auto',
		content: richText as JSONContent,
	})

	try {
		textEditor.commands.selectAll()

		switch (operation) {
			case 'bold':
				active ? textEditor.commands.setBold() : textEditor.commands.unsetBold()
				break
			case 'italic':
				active ? textEditor.commands.setItalic() : textEditor.commands.unsetItalic()
				break
			case 'highlight':
				active
					? (textEditor.commands as any).setHighlight()
					: (textEditor.commands as any).unsetHighlight()
				break
			case 'bulletList': {
				const currentlyActive = textEditor.isActive('bulletList')
				if (currentlyActive !== active) textEditor.commands.toggleBulletList()
				break
			}
		}

		return textEditor.getJSON() as TLRichText
	} finally {
		textEditor.destroy()
	}
}

function RichTextStyleControls() {
	const editor = useEditor()
	const msg = useTranslation()
	const textEditor = useValue('global rich text editor', () => editor.getRichTextEditor(), [editor])
	const [, forceTextEditorRender] = useState(0)

	useEffect(() => {
		if (!textEditor) return

		const refresh = () => forceTextEditorRender((value) => value + 1)
		textEditor.on('update', refresh)
		textEditor.on('selectionUpdate', refresh)
		return () => {
			textEditor.off('update', refresh)
			textEditor.off('selectionUpdate', refresh)
		}
	}, [textEditor])

	const selectionState = useValue(
		'global rich text selection state',
		() => {
			const ids = collectSelectedRichTextShapeIds(editor)
			const shapes = ids
				.map((id) => editor.getShape(id))
				.filter(isRichTextShape)

			return {
				ids,
				bold:
					shapes.length > 0 &&
					shapes.every((shape) => isOperationActive(shape.props.richText, 'bold')),
				italic:
					shapes.length > 0 &&
					shapes.every((shape) => isOperationActive(shape.props.richText, 'italic')),
				bulletList:
					shapes.length > 0 &&
					shapes.every((shape) => isOperationActive(shape.props.richText, 'bulletList')),
				highlight:
					shapes.length > 0 &&
					shapes.every((shape) => isOperationActive(shape.props.richText, 'highlight')),
			}
		},
		[editor],
	)

	if (!textEditor && selectionState.ids.length === 0) return null

	const handleOperation = (operation: RichTextOperation) => {
		const activeTextEditor = editor.getRichTextEditor()
		if (activeTextEditor?.view) {
			switch (operation) {
				case 'bold':
					activeTextEditor.chain().focus().toggleBold().run()
					return
				case 'italic':
					activeTextEditor.chain().focus().toggleItalic().run()
					return
				case 'bulletList':
					activeTextEditor.chain().focus().toggleBulletList().run()
					return
				case 'highlight':
					;(activeTextEditor.chain().focus() as any).toggleHighlight().run()
					return
			}
		}

		const targetActive = !selectionState[operation]
		const updates: TLShapePartial[] = []

		for (const id of selectionState.ids) {
			const shape = editor.getShape(id)
			if (!isRichTextShape(shape)) continue

			updates.push({
				id: shape.id,
				type: shape.type,
				props: {
					richText: transformWholeRichText(
						editor,
						shape.props.richText,
						operation,
						targetActive,
					),
				},
			} as TLShapePartial)
		}

		if (updates.length === 0) return
		editor.run(() => {
			editor.markHistoryStoppingPoint(`toggle global rich text ${operation}`)
			editor.updateShapes(updates)
		})
	}

	const toolbarTitle = msg('tool.rich-text-toolbar-title')

	return (
		<TldrawUiToolbar orientation="horizontal" label={toolbarTitle}>
			{RICH_TEXT_ACTIONS.map(({ operation, icon }) => {
				const isActive = textEditor
					? textEditor.isActive(operation)
					: selectionState[operation]

				return (
					<TldrawUiToolbarButton
						key={operation}
						type="icon"
						title={msg(`tool.rich-text-${operation}` as any)}
						data-testid={`global-rich-text.${operation}`}
						isActive={isActive}
						onPointerDown={preventDefault}
						onClick={() => handleOperation(operation)}
						aria-pressed={isActive}
					>
						<TldrawUiButtonIcon icon={icon} />
					</TldrawUiToolbarButton>
				)
			})}
		</TldrawUiToolbar>
	)
}

function findStyleById<T>(
	styles: ReadonlySharedStyleMap,
	id: string,
): StyleProp<T> | undefined {
	for (const style of styles.keys()) {
		if (style.id === id) return style as StyleProp<T>
	}
	return undefined
}

function TextColorPicker() {
	const editor = useEditor()
	const { styles, onValueChange } = useStylePanelContext()
	const font = styles.get(DefaultFontStyle)
	if (font === undefined) return null

	const labelColorStyle = findStyleById<TLDefaultColorStyle>(styles, 'tldraw:labelColor')
	const textColor = labelColorStyle
		? styles.get(labelColorStyle)
		: styles.get(DefaultColorStyle)

	const items = useValue(
		'text color style panel items',
		() => getColorStyleItems(editor.getCurrentTheme().colors[editor.getColorMode()]),
		[editor],
	)

	if (textColor === undefined) return null

	return (
		<StylePanelButtonPicker
			title="字体颜色"
			uiType="color"
			style={DefaultColorStyle}
			items={items}
			value={textColor}
			onValueChange={(_style, value) =>
				onValueChange(labelColorStyle ?? DefaultColorStyle, value)
			}
		/>
	)
}

function CustomStylePanelContent() {
	return (
		<>
			<StylePanelSection>
				<StylePanelColorPicker />
				<StylePanelOpacityPicker />
			</StylePanelSection>
			<StylePanelSection>
				<StylePanelFillPicker />
				<StylePanelDashPicker />
				<StylePanelSizePicker />
			</StylePanelSection>
			<StylePanelSection>
				<StylePanelFontPicker />
				<StylePanelTextAlignPicker />
				<StylePanelLabelAlignPicker />
				<RichTextStyleControls />
				<TextColorPicker />
			</StylePanelSection>
			<StylePanelSection>
				<StylePanelGeoShapePicker />
				<StylePanelArrowKindPicker />
				<StylePanelArrowheadPicker />
				<StylePanelSplinePicker />
			</StylePanelSection>
		</>
	)
}

export function CustomStylePanel(props: TLUiStylePanelProps) {
	return (
		<DefaultStylePanel {...props}>
			<CustomStylePanelContent />
		</DefaultStylePanel>
	)
}
