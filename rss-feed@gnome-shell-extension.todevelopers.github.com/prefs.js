/*
 * RSS Feed extension for GNOME Shell
 *
 * Copyright (C) 2015
 *     Tomas Gazovic <gazovic.tomasgmail.com>,
 *     Janka Gazovicova <jana.gazovicova@gmail.com>
 *
 * This file is part of gnome-shell-extension-rss-feed.
 *
 * gnome-shell-extension-rss-feed is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * gnome-shell-extension-rss-feed is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with gnome-shell-extension-rss-feed.  If not, see <http://www.gnu.org/licenses/>.
 */
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Soup = imports.gi.Soup;
const Lang = imports.lang;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;
const Settings = Convenience.getSettings();

const Mainloop = imports.mainloop;

const Gettext = imports.gettext.domain('rss-feed');
const _ = Gettext.gettext;

const HTTP = Me.imports.http;
const Parser = Me.imports.parsers.factory;

const COLUMN_ID = 0;
const COLUMN_ID_STATUS = 1;
const MAX_UPDATE_INTERVAL = 1440;
const MAX_SOURCES_LIMIT = 1024;
const MAX_POLL_DELAY = 9999;
const MAX_HEIGHT = 8192;
const MAX_NOTIFICATIONS = 100;

const RSS_FEEDS_LIST_KEY = 'rss-feeds-list';
const UPDATE_INTERVAL_KEY = 'update-interval';
const ITEMS_VISIBLE_KEY = 'items-visible';
const ENABLE_NOTIFICATIONS_KEY = 'enable-notifications';
const POLL_DELAY_KEY = 'fpoll-timeout';
const MAX_HEIGHT_KEY = 'max-height';
const ENABLE_ANIMATIONS_KEY = 'enable-anim';
const PRESERVE_ON_LOCK_KEY = 'preserve-on-lock';
const MAX_NOTIFICATIONS_KEY = 'notification-limit';
const ENABLE_DESC_KEY = 'enable-descriptions';
const ENABLE_DEBUG_KEY = 'enable-debug';
const MB_ALIGN_TOP_KEY = 'menu-buttons-align-top'

const Log = Me.imports.logger;

const GSE_TOOL_PATH = 'gnome-shell-extension-tool';

/*
 *	RssFeedSettingsWidget class for settings widget
 */
const RssFeedSettingsWidget = new GObject.Class(
{
	Name: 'RssFeed.Prefs.RssFeedSettingsWidget',
	GTypeName: 'RssFeedSettingsWidget',
	Extends: Gtk.Box,

	/*
	 *	Initialize new instance of RssFeedSettingsWidget class
	 */
	_init: function(params)
	{
		this.parent(params);
		this.orientation = Gtk.Orientation.VERTICAL;
		this.margin_left = 10;
		this.margin_right = 10;
		this.margin_top = 10;
		this.margin_bottom = 2;

		this._httpSession = new Soup.SessionAsync({
			timeout: 30
		});

		Soup.Session.prototype.add_feature.call(this._httpSession, new Soup.ProxyResolverDefault());

		this._fCache = new Array();

		if (this.set_size_request)
			this.set_size_request(600, 600);

		this._addSeparator(this, 0, 9);

		let upper_box = new Gtk.Box(
		{
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 8
		});
		{
			let general_box = new Gtk.Box(
			{
				orientation: Gtk.Orientation.VERTICAL,
				spacing: 6,
				hexpand: true
			});
			general_box.set_margin_bottom(6);
			{
	
				this._addSpinButton(general_box, UPDATE_INTERVAL_KEY, _("Update interval (min):"), MAX_UPDATE_INTERVAL);
				this._addSpinButton(general_box, POLL_DELAY_KEY, _("Poll delay (ms):"), MAX_POLL_DELAY);
				this._addSwitch(general_box, PRESERVE_ON_LOCK_KEY, _("Preserve when screen off:"));

				let debug_box = new Gtk.Box(
				{
					orientation: Gtk.Orientation.HORIZONTAL,
					spacing: 6,
					hexpand: true
				});
				{
					let reloadButton = new Gtk.ToolButton(
					{
						icon_name: 'view-refresh-symbolic'
					});
					reloadButton.connect('clicked', Lang.bind(this, function()
					{
						if (this._rldTimeout)
							return;

						if (!try_spawn([GSE_TOOL_PATH, '-d', Me.uuid]))
							return;

						this._rldTimeout = Mainloop.timeout_add_seconds(1, Lang.bind(this, function()
						{
							this._rldTimeout = undefined;
							try_spawn([GSE_TOOL_PATH, '-e', Me.uuid])
						}));
					}));
					reloadButton.set_tooltip_text(_("Reactivate extension"));

					let box_dbgsw = this._createControlBase(_("Debug mode:")); 
					box_dbgsw.set_hexpand(true);
					box_dbgsw.add(reloadButton);
					
					let dbg_sw = new Gtk.Switch(
					{
						active: Settings.get_boolean(ENABLE_DEBUG_KEY),
						vexpand: false,
						margin_top: 2,
						margin_bottom: 2
					});

					dbg_sw.connect('notify::active', Lang.bind(this, function(b)
					{
						Settings.set_boolean(ENABLE_DEBUG_KEY, b.active);
					}));

					box_dbgsw.add(dbg_sw);

					debug_box.add(box_dbgsw);
				}

				general_box.add(debug_box);
			}

			upper_box.add(general_box);

			this._addSeparator(upper_box, 2, 8);

			let menu_box = new Gtk.Box(
			{
				orientation: Gtk.Orientation.VERTICAL,
				spacing: 8,
				hexpand: true
			});
			menu_box.set_margin_bottom(6);
			{
				this._addSpinButton(menu_box, MAX_HEIGHT_KEY, _("Max menu height (px):"), MAX_HEIGHT);
				this._addSpinButton(menu_box, ITEMS_VISIBLE_KEY, _("Max items per source:"), MAX_SOURCES_LIMIT);
				this._addSwitch(menu_box, ENABLE_ANIMATIONS_KEY,_("Enable animations:"));
				this._addSwitch(menu_box, MB_ALIGN_TOP_KEY,_("Top-align buttons:"));
				this._addSwitch(menu_box, ENABLE_DESC_KEY,_("Show descriptions:"));
			}

			upper_box.add(menu_box);
		}

		this.add(upper_box);
		
		this._addSeparator(this, 8, 12);

		this._addSwitch(this, ENABLE_NOTIFICATIONS_KEY, _("Show notifications:"));
		this._addSpinButton(this, MAX_NOTIFICATIONS_KEY, _("Max notifications:"), MAX_NOTIFICATIONS);

		this._addSeparator(this, 2, 8);

		// sources label
		let boxsources = new Gtk.Box(
		{
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 6
		});
		boxsources.set_margin_bottom(6);
		boxsources.set_margin_top(4);
		let labels = new Gtk.Label(
		{
			xalign: Gtk.Align.CENTER,
			label: _("RSS sources")
		});
		boxsources.pack_start(labels, true, true, 0);
		
		let checkRSSButton = new Gtk.ToolButton(
		{
			icon_name: 'view-refresh-symbolic'
		});
		checkRSSButton.connect('clicked', Lang.bind(this, function()
		{
			let [res, iter] = this._store.get_iter_first();
			let path;
			
			while ( res )
			{
				path = this._store.get_path(iter);
								
				let cacheObj = this._fCache[path.get_indices()];
				
				if (!cacheObj)
					throw "FIXME: cache object and ListStore out of sync";
				
				this._validateItemURL(iter, cacheObj);
				
				path.next();
				
				[res, iter] = this._store.get_iter(path);
			}
		}));
		checkRSSButton.set_tooltip_text(_("Re-check all RSS sources"))
		
		boxsources.add(checkRSSButton);

		this.add(boxsources);

		// rss feed sources
		let scrolledWindow = new Gtk.ScrolledWindow();
		scrolledWindow.set_border_width(0);
		scrolledWindow.set_shadow_type(1);

		this._store = new Gtk.ListStore();
		this._store.set_column_types([GObject.TYPE_STRING, GObject.TYPE_STRING]);
		this._loadStoreFromSettings();

		this._actor = new Gtk.TreeView(
		{
			model: this._store,
			headers_visible: true,
			headers_clickable: true,
			reorderable: true,
			hexpand: true,
			vexpand: true,
			enable_search: true
		});

		this._actor.set_search_equal_func(
			Lang.bind(this, function(model, column, key, iter)
			{
				if (model.get_value(iter, COLUMN_ID).match(key))
					return false;
				else
					return true;
			}));

		this._actor.get_selection().set_mode(Gtk.SelectionMode.SINGLE);

		let column_url = new Gtk.TreeViewColumn();

		let cell_url = new Gtk.CellRendererText(
		{
			editable: true
		});
		column_url.pack_start(cell_url, true);
		column_url.add_attribute(cell_url, "text", COLUMN_ID);

		column_url.set_title(_("URL"));

		this._actor.append_column(column_url);

		let column_status = new Gtk.TreeViewColumn();

		let cell_status = new Gtk.CellRendererText(
		{
			editable: false
		});
		column_status.pack_start(cell_status, false);
		column_status.add_attribute(cell_status, "text", COLUMN_ID_STATUS);
		column_status.set_title(_("Status"));

		this._actor.append_column(column_status);

		this._actor.connect('row-activated', Lang.bind(this,
			function(self, path, column)
			{
				let [res, iter] = this._store.get_iter(path);

				if (!res)
					return;

				let index = path.get_indices();

				if (index > this._fCache)
					return;

				let cacheObj = this._fCache[index];

				this._validateItemURL(iter, cacheObj);
			}));

		cell_url.connect('edited', Lang.bind(this,
			function(self, str_path, text)
			{
				if (!text.length)
					return;

				let path = Gtk.TreePath.new_from_string(str_path);

				if (!path)
					return;

				let [res, iter] = this._store.get_iter(path);

				if (!res)
					return;

				this._store.set_value(iter, COLUMN_ID, text);
			}));

		this._store.connect('row-inserted', Lang.bind(this,
			function(tree, path, iter)
			{
				let feeds = Settings.get_strv(RSS_FEEDS_LIST_KEY);

				if (feeds == null)
					feeds = new Array()

				let index = path.get_indices();

				if (index > feeds.length)
					return;

				feeds.splice(index, 0, ""); // placeholder
				this._fCache.splice(index, 0, new Object());

				Settings.set_strv(RSS_FEEDS_LIST_KEY, feeds);
			}));

		this._store.connect('row-changed', Lang.bind(this,
			function(tree, path, iter)
			{
				let feeds = Settings.get_strv(RSS_FEEDS_LIST_KEY);

				if (feeds == null)
					feeds = new Array()

				let index = path.get_indices();

				if (index >= feeds.length)
					return;

				let urlValue = this._store.get_value(iter, COLUMN_ID);

				// detect URL column changes
				if (urlValue == feeds[index])
					return;

				feeds[index] = urlValue;

				let cacheObj = this._fCache[index];
				cacheObj.v = urlValue;

				Settings.set_strv(RSS_FEEDS_LIST_KEY, feeds);

				this._validateItemURL(iter, cacheObj);
			}));

		this._store.connect('row-deleted', Lang.bind(this,
			function(tree, path)
			{
				let feeds = Settings.get_strv(RSS_FEEDS_LIST_KEY);
				if (feeds == null)
					feeds = new Array();

				let index = path.get_indices();

				if (index >= feeds.length)
					return;

				let cacheObj = this._fCache[index];
				if (cacheObj.p)
					this._httpSession.cancel_message(cacheObj.p, Soup.Status.CANCELLED);

				feeds.splice(index, 1);
				this._fCache.splice(index, 1);

				Settings.set_strv(RSS_FEEDS_LIST_KEY, feeds);

			}));

		scrolledWindow.add(this._actor);
		this.add(scrolledWindow);

		let box_toolbar = new Gtk.Box(
		{
			orientation: Gtk.Orientation.HORIZONTAL
		});

		let toolbar = new Gtk.Toolbar();
		toolbar.get_style_context().add_class(Gtk.STYLE_CLASS_TOOLBAR);

		toolbar.set_icon_size(1);

		let delButton = new Gtk.ToolButton(
		{
			icon_name: 'list-remove-symbolic'
		});
		delButton.connect('clicked', Lang.bind(this, this._deleteSelected));
		toolbar.add(delButton);

		let newButton = new Gtk.ToolButton(
		{
			hexpand: true,
			icon_name: 'list-add-symbolic'
		});
		newButton.connect('clicked', Lang.bind(this, this._createNew));
		toolbar.add(newButton);

		box_toolbar.add(toolbar);

		let toolbar2 = new Gtk.Toolbar();
		toolbar2.set_icon_size(1);

		let moveUpButton = new Gtk.ToolButton(
		{
			icon_name: 'go-up-symbolic'
		});
		moveUpButton.connect('clicked', Lang.bind(this, this._moveItem, true));
		toolbar2.add(moveUpButton);

		let moveDownButton = new Gtk.ToolButton(
		{
			icon_name: 'go-down-symbolic'
		});
		moveDownButton.connect('clicked', Lang.bind(this, this._moveItem, false));
		toolbar2.add(moveDownButton);

		box_toolbar.add(toolbar2);
		box_toolbar.get_style_context().add_class(Gtk.STYLE_CLASS_TOOLBAR);

		this.add(box_toolbar);
	},

	/* 
	 * Validates the URL of an item and displays
	 * result in 'Status' column
	 */
	_validateItemURL: function(iter, cacheObj)
	{
		let url = this._store.get_value(iter, COLUMN_ID);

		let params = HTTP.getParametersAsJson(url);

		let l2o = url.indexOf('?');
		if (l2o != -1) url = url.substr(0, l2o);

		let request = Soup.form_request_new_from_hash('GET', url, JSON.parse(params));

		if (!request)
		{
			this._store.set_value(iter, COLUMN_ID_STATUS, _("Invalid URL"));
			return;
		}

		if (cacheObj.p)
			this._httpSession.cancel_message(cacheObj.p, Soup.Status.CANCELLED);

		cacheObj.p = request;

		this._store.set_value(iter, COLUMN_ID_STATUS, _("Checking") + "..");

		this._httpSession.queue_message(request, Lang.bind(this,
			function(session, message)
			{
				cacheObj.p = undefined;

				if (message.status_code == Soup.Status.CANCELLED)
					return;

				if (!((message.status_code) >= 200 && (message.status_code) < 300))
				{
					this._store.set_value(iter, COLUMN_ID_STATUS,
						Soup.Status.get_phrase(message.status_code));
					return;
				}
				let parser;

				try
				{
					parser = Parser.createRssParser(message.response_body.data);
				} catch (e)
				{
					this._store.set_value(iter, COLUMN_ID_STATUS, _("EXCEPTION"));
					Log.Error(e);
					return;
				}

				if (parser == null)
				{
					this._store.set_value(iter, COLUMN_ID_STATUS, _("RSS parsing error"));
					return;
				}

				this._store.set_value(iter, COLUMN_ID_STATUS, _("OK") + " - " + parser._type);
			}));

		return request;
	},
	
	_createControlBase: function(text)
	{
		let box = new Gtk.Box(
		{
			orientation: Gtk.Orientation.HORIZONTAL,
			spacing: 6
		});
		box.set_margin_bottom(6);
		let label = new Gtk.Label(
		{
			xalign: Gtk.Align.FILL,
			label: text
		});
		box.pack_start(label, true, true, 0);
		
		return box;
	},

	_addSwitch: function(parent, key, text)
	{
		let box = this._createControlBase(text);

		let sw = new Gtk.Switch(
		{
			active: Settings.get_boolean(key)
		});
		sw.connect('notify::active', Lang.bind(this, function(b)
		{
			Settings.set_boolean(key, b.active);
		}));

		box.add(sw);
		
		parent.add(box);

		return box;
	},
	
	_addSpinButton: function(parent, key, text, limit)
	{
		let box = this._createControlBase(text);

		let spin = Gtk.SpinButton.new_with_range(1, limit, 1);
		spin.set_value(Settings.get_int(key));
		Settings.bind(key, spin, 'value', Gio.SettingsBindFlags.DEFAULT);

		box.add(spin);

		parent.add(box);

		return box;
	},
	
	_addSeparator: function(parent, margin_top, margin_bottom)
	{
		let sep = new Gtk.Separator(
		{
			orientation: Gtk.Orientation.HORIZONTAL
		});
		sep.set_margin_top(margin_top);
		sep.set_margin_bottom(margin_bottom);

		parent.add(sep);
		
		return sep;
	},
	
	/*
	 *	Creates modal dialog when adding new or editing RSS source
	 *	title - dialog title
	 *	text - text in dialog
	 *	onOkButton - callback on OK button clicked
	 */
	_createDialog: function(title, text, onOkButton)
	{

		let dialog = new Gtk.Dialog(
		{
			title: title
		});
		dialog.set_modal(true);
		dialog.set_resizable(false);
		dialog.set_border_width(12);

		this._entry = new Gtk.Entry(
		{
			text: text
		});
		//this._entry.margin_top = 12;
		this._entry.margin_bottom = 12;
		this._entry.width_chars = 40;

		this._entry.connect("changed", Lang.bind(this, function()
		{

			if (this._entry.get_text().length === 0)
				this._okButton.sensitive = false;
			else
				this._okButton.sensitive = true;
		}));

		dialog.add_button(Gtk.STOCK_CANCEL, 0);
		this._okButton = dialog.add_button(Gtk.STOCK_OK, 1); // default
		this._okButton.set_can_default(true);
		this._okButton.sensitive = false;
		dialog.set_default(this._okButton);
		this._entry.activates_default = true;

		let dialog_area = dialog.get_content_area();
		//dialog_area.pack_start(label, 0, 0, 0);
		dialog_area.pack_start(this._entry, 0, 0, 0);

		dialog.connect("response", Lang.bind(this, function(w, response_id)
		{

			if (response_id > -1)
			{ // button OK
				onOkButton(response_id);
			}

			dialog.hide();
		}));

		dialog.show_all();
	},

	/*
	 *	Move selected item on the list
	 */
	_moveItem: function(self, direction)
	{

		let [any, model, iter] = this._actor.get_selection().get_selected();

		if (!any)
			return;

		let path = model.get_path(iter);

		if (!direction)
			path.next();
		else
			path.prev();

		let [res, iter_step] = model.get_iter(path);

		if (!res)
			return;

		this._store.swap(iter, iter_step);

		let index = model.get_path(iter).get_indices();
		let index_step = model.get_path(iter_step).get_indices();

		let feeds = Settings.get_strv(RSS_FEEDS_LIST_KEY);

		if (feeds == null)
			feeds = new Array();

		if (index < feeds.length && index_step < feeds.length)
		{
			feeds[index] = model.get_value(iter, COLUMN_ID);
			feeds[index_step] = model.get_value(iter_step, COLUMN_ID);

			let it = this._fCache[index];
			this._fCache[index] = this._fCache[index_step];
			this._fCache[index_step] = it;

			Settings.set_strv(RSS_FEEDS_LIST_KEY, feeds);
		}
	},


	/*
	 *	On create new clicked callback
	 */
	_createNew: function()
	{
		this._createDialog(_("New RSS Feed source"), '', Lang.bind(this, function(id)
		{
			let text = this._entry.get_text();

			if (!text.length)
				return;

			// update tree view
			let iter = this._store.append();
			this._store.set_value(iter, COLUMN_ID, text);
		}));
	},

	/*
	 *	On delete clicked callback
	 */
	_deleteSelected: function()
	{
		let [any, model, iter] = this._actor.get_selection().get_selected();

		if (any)
		{
			// must call before remove
			let index = model.get_path(iter).get_indices();
			// update tree view
			this._store.remove(iter);
		}
	},

	/*
	 *	Loads RSS feeds entries from gsettings structure
	 */
	_loadStoreFromSettings: function()
	{
		let feeds = Settings.get_strv(RSS_FEEDS_LIST_KEY);

		if (feeds)
		{
			for (let i = 0; i < feeds.length; i++)
			{
				let iter = this._store.append();
				this._store.set_value(iter, COLUMN_ID, feeds[i]);
				let cacheObj = this._fCache[i] = new Object();
				cacheObj.v = feeds[i];
				this._validateItemURL(iter, cacheObj);
			}
		}
	}
});

function try_spawn(argv)
{
	var success, pid;

	try
	{
		[success, pid] = GLib.spawn_sync(null, argv, null,
			GLib.SpawnFlags.SEARCH_PATH, null);
	}
	catch (err)
	{
		Log.Error(err);
		return false;
	}

	return success;
}


/*
 *	Initialize the settings widget
 */
function init()
{
	Convenience.initTranslations("rss-feed");
}

/*
 *	Builds settings widget
 */
function buildPrefsWidget()
{
	let widget = new RssFeedSettingsWidget();
	widget.show_all();

	return widget;
}
