import type { Catalog } from '../authoring/catalog';
import Text from './Text.svelte';
import Button from './Button.svelte';
import Card from './Card.svelte';
import Column from './Column.svelte';
import Row from './Row.svelte';
import List from './List.svelte';
import Tabs from './Tabs.svelte';
import TextField from './TextField.svelte';
import Checkbox from './Checkbox.svelte';
import Image from './Image.svelte';
import Icon from './Icon.svelte';
import Divider from './Divider.svelte';
import Slider from './Slider.svelte';
import DateTimeInput from './DateTimeInput.svelte';
import MultipleChoice from './MultipleChoice.svelte';
import Modal from './Modal.svelte';

/**
 * Default catalog covering the full A2UI v0.8 standard component catalog
 * (https://a2ui.dev/specification/v0.8): the 16 standard component types
 * — Text, Image, Icon, Divider, Button, TextField, CheckBox, Slider,
 * DateTimeInput, MultipleChoice, Row, Column, List, Card, Modal, Tabs.
 * Use as-is, extend with your own, or build a fresh catalog per
 * `createCatalog`.
 *
 * `AutocompleteField` and `A2UIRepresentation` are intentionally NOT
 * included — they are authoring-only composite helpers, not standard
 * spec components. `AutocompleteField` is exported separately from
 * `a2ui-svelte/components` for consumers who want it. The default catalog
 * mirrors the spec only. To make `AutocompleteField` agent-renderable on a
 * dynamic surface, do:
 *
 *   import { AutocompleteField } from 'a2ui-svelte/components';
 *   extendCatalog(DEFAULT_CATALOG, { AutocompleteField });
 *
 * See docs/reference/components.md § "Extensions" for the composite-pattern
 * contract these authoring-only helpers follow.
 */
export const DEFAULT_CATALOG: Catalog = {
	Text,
	Image,
	Icon,
	Divider,
	Button,
	TextField,
	// Spec component type name is `CheckBox`; the Svelte file is `Checkbox.svelte`.
	CheckBox: Checkbox,
	Slider,
	DateTimeInput,
	MultipleChoice,
	Row,
	Column,
	List,
	Card,
	Modal,
	Tabs
};
