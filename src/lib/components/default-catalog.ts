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

/**
 * Default catalog covering the A2UI v0.8 standard component types
 * (https://a2ui.dev/specification/v0.8). Use as-is, extend with your own,
 * or build a fresh catalog per `createCatalog`.
 *
 * `AutocompleteField` is intentionally NOT included — it is a Souschef-flavoured
 * composite component, exported separately from `a2ui-svelte/components` for
 * consumers who want it. The default catalog mirrors the spec only. To make
 * it agent-renderable on a dynamic surface, do:
 *
 *   import { AutocompleteField } from 'a2ui-svelte/components';
 *   extendCatalog(DEFAULT_CATALOG, { AutocompleteField });
 */
export const DEFAULT_CATALOG: Catalog = {
	Text,
	Button,
	Card,
	Column,
	Row,
	List,
	Tabs,
	TextField,
	Checkbox
};
