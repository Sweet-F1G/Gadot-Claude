@tool
extends EditorPlugin

const VERSION := "0.2.0"
const DEFAULT_PORT := 8787
const MAX_PORT := 8796
const MAX_REQUEST_BYTES := 65536
const IDLE_TIMEOUT_MS := 3000
const MAX_PROPERTIES := 40
const MAX_CHILDREN := 50
const MAX_TEXT := 500
const MAX_ARRAY_ITEMS := 8
const SCREENSHOT_WIDTH := 960
const MAX_PNG_BYTES := 1000000
const LOG_PATH := "user://logs/godot.log"
const LOG_TAIL_BYTES := 65536
const SCAN_TIMEOUT_MS := 4000
const ERROR_PREFIXES := ["ERROR", "SCRIPT ERROR", "USER ERROR", "WARNING", "USER WARNING", "SHADER ERROR"]

var _server := TCPServer.new()
var _peer: StreamPeerTCP
var _request := PackedByteArray()
var _peer_since := 0
var _busy := false
var _port := -1
var _token := ""
var _class_defaults := {}


func _enter_tree() -> void:
	_token = Crypto.new().generate_random_bytes(16).hex_encode()
	_port = _listen()
	if _port < 0:
		set_process(false)
		return
	if not _write_session():
		_server.stop()
		_port = -1
		set_process(false)
		return
	set_process(true)
	print("Claude Godot %s listening on 127.0.0.1:%d" % [VERSION, _port])


func _exit_tree() -> void:
	set_process(false)
	_close_peer()
	_server.stop()
	if _port >= 0:
		_delete_session()
	_port = -1


func _process(_delta: float) -> void:
	if _port < 0 or _busy:
		return
	if _peer == null:
		if not _server.is_connection_available():
			return
		_peer = _server.take_connection()
		_request = PackedByteArray()
		_peer_since = Time.get_ticks_msec()
	_peer.poll()
	if _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		_close_peer()
		return
	var available := _peer.get_available_bytes()
	if available > 0:
		var chunk: Array = _peer.get_data(available)
		if chunk[0] == OK:
			_request.append_array(chunk[1])
	var newline := _request.find(10)
	if newline == -1:
		if _request.size() > MAX_REQUEST_BYTES:
			_reply({"id": null, "error": "request too large"})
		elif Time.get_ticks_msec() - _peer_since > IDLE_TIMEOUT_MS:
			_close_peer()
		return
	_busy = true
	_serve(_request.slice(0, newline).get_string_from_utf8())


func _serve(line: String) -> void:
	var response: Dictionary = await _dispatch(line)
	_reply(response)


func _reply(payload: Dictionary) -> void:
	if _peer and _peer.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		_peer.put_data((JSON.stringify(payload) + "\n").to_utf8_buffer())
	_close_peer()
	_busy = false


func _close_peer() -> void:
	if _peer:
		_peer.disconnect_from_host()
	_peer = null
	_request = PackedByteArray()


func _listen() -> int:
	for port in range(DEFAULT_PORT, MAX_PORT + 1):
		_server.stop()
		if _server.listen(port, "127.0.0.1") == OK:
			return port
	push_error("Claude Godot: ports %d-%d are busy" % [DEFAULT_PORT, MAX_PORT])
	return -1


func _session_path() -> String:
	return ProjectSettings.globalize_path("res://.claude-godot/session.json")


func _write_session() -> bool:
	var session_path := _session_path()
	DirAccess.make_dir_recursive_absolute(session_path.get_base_dir())
	var file := FileAccess.open(session_path, FileAccess.WRITE)
	if file == null:
		push_error("Claude Godot: cannot write " + session_path)
		return false
	file.store_string(JSON.stringify({
		"port": _port,
		"token": _token,
		"project": ProjectSettings.globalize_path("res://"),
		"version": VERSION,
	}))
	return true


func _delete_session() -> void:
	var session_path := _session_path()
	if not FileAccess.file_exists(session_path):
		return
	var stored = JSON.parse_string(FileAccess.get_file_as_string(session_path))
	if typeof(stored) == TYPE_DICTIONARY and str(stored.get("token", "")) != _token:
		return
	DirAccess.remove_absolute(session_path)


func _dispatch(line: String) -> Dictionary:
	var parsed = JSON.parse_string(line)
	if typeof(parsed) != TYPE_DICTIONARY:
		return {"id": null, "error": "invalid json"}
	var id = parsed.get("id")
	if str(parsed.get("token", "")) != _token:
		return {"id": id, "error": "bad token"}
	var params = parsed.get("params", {})
	if typeof(params) != TYPE_DICTIONARY:
		params = {}
	var result: Dictionary = await _call(str(parsed.get("method", "")), params)
	if result.has("error"):
		return {"id": id, "error": str(result["error"])}
	return {"id": id, "result": result}


func _call(method: String, params: Dictionary) -> Dictionary:
	match method:
		"status":
			return _status()
		"scene_tree":
			return _scene_tree(_int_param(params, "depth", 4, 1, 8), _int_param(params, "limit", 80, 1, 200))
		"node":
			return _node(str(params.get("path", ".")), params.get("properties", []))
		"set_property":
			return _set_property(str(params.get("path", ".")), str(params.get("property", "")), params.get("value"), _flag_param(params, "save"))
		"screenshot":
			return await _screenshot(str(params.get("view", "2d")))
		"log":
			return _log(_int_param(params, "lines", 40, 1, 80), _flag_param(params, "errors_only"))
		"play":
			return await _play(str(params.get("action", "")))
		"refresh":
			return await _refresh(str(params.get("scene", "")))
	return {"error": "unknown method %s" % method}


func _int_param(params: Dictionary, key: String, fallback: int, low: int, high: int) -> int:
	var value = params.get(key, fallback)
	if typeof(value) != TYPE_INT and typeof(value) != TYPE_FLOAT:
		return fallback
	return clampi(int(value), low, high)


func _flag_param(params: Dictionary, key: String) -> bool:
	var value = params.get(key, false)
	return typeof(value) == TYPE_BOOL and value


func _status() -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	var info := Engine.get_version_info()
	return {
		"addon": VERSION,
		"godot": "%d.%d.%d" % [info.major, info.minor, info.patch],
		"project_name": str(ProjectSettings.get_setting("application/config/name", "")),
		"project": ProjectSettings.globalize_path("res://"),
		"scene": root.scene_file_path if root else "",
		"open_scenes": Array(EditorInterface.get_open_scenes()),
		"playing": EditorInterface.is_playing_scene(),
	}


func _scene_tree(max_depth: int, limit: int) -> Dictionary:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return {"scene": "", "nodes": []}
	var nodes: Array = []
	var state := {"left": limit, "truncated": false}
	_walk(root, root, ".", 0, max_depth, nodes, state)
	return {"scene": root.scene_file_path, "truncated": state["truncated"], "nodes": nodes}


func _walk(root: Node, node: Node, node_path: String, depth: int, max_depth: int, nodes: Array, state: Dictionary) -> void:
	if state["left"] <= 0:
		state["truncated"] = true
		return
	state["left"] -= 1
	var entry := {"path": node_path, "type": node.get_class()}
	var attached = node.get_script()
	if attached is Script and attached.resource_path != "":
		entry["script"] = attached.resource_path
	if node != root and node.scene_file_path != "":
		entry["instance"] = node.scene_file_path
	var children := _scene_children(root, node)
	nodes.append(entry)
	if depth >= max_depth:
		if not children.is_empty():
			entry["children"] = children.size()
		return
	for child in children:
		var child_path := str(child.name) if node_path == "." else "%s/%s" % [node_path, child.name]
		_walk(root, child, child_path, depth + 1, max_depth, nodes, state)


func _scene_children(root: Node, node: Node) -> Array[Node]:
	var output: Array[Node] = []
	for child in node.get_children():
		if child.owner == root or (child.owner != null and root.is_editable_instance(child.owner)):
			output.append(child)
	return output


func _node(node_path: String, wanted) -> Dictionary:
	var node := _resolve(node_path)
	if node == null:
		return {"error": "no node at %s" % node_path}
	var entry := {"path": node_path, "type": node.get_class()}
	var attached = node.get_script()
	if attached is Script:
		entry["script"] = attached.resource_path
	if typeof(wanted) == TYPE_ARRAY and not wanted.is_empty():
		var values := {}
		var missing: Array = []
		for item in wanted:
			var prop_name := str(item)
			if _is_property_name(prop_name) and not _property_info(node, prop_name).is_empty():
				values[prop_name] = _to_json(node.get(prop_name))
			else:
				missing.append(prop_name)
		entry["properties"] = values
		if not missing.is_empty():
			entry["missing"] = missing
	else:
		var props := _changed_properties(node, attached)
		entry["properties"] = props["values"]
		if props["more"] > 0:
			entry["more_properties"] = props["more"]
	var names: Array = []
	var children := _scene_children(EditorInterface.get_edited_scene_root(), node)
	for child in children:
		if names.size() >= MAX_CHILDREN:
			break
		names.append(str(child.name))
	entry["children"] = names
	if children.size() > names.size():
		entry["more_children"] = children.size() - names.size()
	return entry


func _changed_properties(node: Node, attached) -> Dictionary:
	var groups: Array = []
	var current: Array = []
	for prop in node.get_property_list():
		var usage := int(prop["usage"])
		if usage & PROPERTY_USAGE_CATEGORY:
			if not current.is_empty():
				groups.append(current)
			current = []
			continue
		if (usage & PROPERTY_USAGE_EDITOR) == 0 or (usage & (PROPERTY_USAGE_GROUP | PROPERTY_USAGE_SUBGROUP)) != 0:
			continue
		var prop_name := str(prop["name"])
		if prop_name == "script" or int(prop["type"]) == TYPE_NIL:
			continue
		current.append(prop_name)
	if not current.is_empty():
		groups.append(current)
	groups.reverse()

	var defaults := _defaults_for(node.get_class())
	var script_names := {}
	if attached is Script:
		for prop in attached.get_script_property_list():
			script_names[str(prop["name"])] = true
	var values := {}
	var more := 0
	for group in groups:
		for prop_name in group:
			var value = _to_json(node.get(prop_name))
			var fallback = null
			var known := false
			if script_names.has(prop_name):
				fallback = _to_json(attached.get_property_default_value(prop_name))
				known = true
			elif defaults.has(prop_name):
				fallback = defaults[prop_name]
				known = true
			if known and _same(value, fallback):
				continue
			if values.size() >= MAX_PROPERTIES:
				more += 1
				continue
			values[prop_name] = value
	return {"values": values, "more": more}


func _defaults_for(cls: String) -> Dictionary:
	if _class_defaults.has(cls):
		return _class_defaults[cls]
	var values := {}
	if ClassDB.can_instantiate(cls):
		var sample = ClassDB.instantiate(cls)
		if sample is Object:
			for prop in sample.get_property_list():
				if int(prop["usage"]) & PROPERTY_USAGE_EDITOR:
					values[str(prop["name"])] = _to_json(sample.get(str(prop["name"])))
			if not (sample is RefCounted):
				sample.free()
	_class_defaults[cls] = values
	return values


func _same(a, b) -> bool:
	return typeof(a) == typeof(b) and a == b


func _to_json(value, depth := 0):
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT:
			return value
		TYPE_FLOAT:
			if is_finite(value):
				return value
			return str(value)
		TYPE_STRING, TYPE_STRING_NAME, TYPE_NODE_PATH:
			var text := str(value)
			return text if text.length() <= MAX_TEXT else text.substr(0, MAX_TEXT) + "..."
		TYPE_VECTOR2, TYPE_VECTOR2I:
			return {"x": value.x, "y": value.y}
		TYPE_VECTOR3, TYPE_VECTOR3I:
			return {"x": value.x, "y": value.y, "z": value.z}
		TYPE_COLOR:
			return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
		TYPE_OBJECT:
			if not is_instance_valid(value):
				return null
			if value is Resource:
				return value.resource_path if value.resource_path != "" else "<%s>" % value.get_class()
			return "<%s>" % value.get_class()
		TYPE_DICTIONARY:
			return "<Dictionary size %d>" % value.size()
		TYPE_ARRAY, TYPE_PACKED_BYTE_ARRAY, TYPE_PACKED_INT32_ARRAY, TYPE_PACKED_INT64_ARRAY, TYPE_PACKED_FLOAT32_ARRAY, TYPE_PACKED_FLOAT64_ARRAY, TYPE_PACKED_STRING_ARRAY, TYPE_PACKED_VECTOR2_ARRAY, TYPE_PACKED_VECTOR3_ARRAY, TYPE_PACKED_COLOR_ARRAY:
			if depth > 0 or value.size() > MAX_ARRAY_ITEMS:
				return "<%s size %d>" % [type_string(typeof(value)), value.size()]
			var items: Array = []
			for item in value:
				items.append(_to_json(item, depth + 1))
			return items
	var fallback := str(value)
	return fallback if fallback.length() <= MAX_TEXT else fallback.substr(0, MAX_TEXT) + "..."


func _set_property(node_path: String, property: String, value, save: bool) -> Dictionary:
	if not _is_property_name(property):
		return {"error": "property is not a valid name"}
	var node := _resolve(node_path)
	if node == null:
		return {"error": "no node at %s" % node_path}
	var new_value = null
	if property == "script":
		new_value = _load_script(value)
		if new_value == null:
			return {"error": "script must be a res:// path to a .gd file that loads"}
	else:
		var info := _property_info(node, property)
		if info.is_empty():
			return {"error": "unknown property %s" % property}
		if int(info["usage"]) & PROPERTY_USAGE_READ_ONLY:
			return {"error": "%s is read-only" % property}
		new_value = _coerce(int(info["type"]), value)
		if typeof(new_value) == TYPE_NIL:
			return {"error": "value does not fit %s (%s)" % [property, type_string(int(info["type"]))]}
	var undo := get_undo_redo()
	undo.create_action("Claude: set %s.%s" % [node.name, property], UndoRedo.MERGE_DISABLE, node)
	undo.add_do_property(node, property, new_value)
	undo.add_undo_property(node, property, node.get(property))
	undo.commit_action()
	var result := {"path": node_path, "property": property, "value": _to_json(node.get(property))}
	if save:
		result["saved"] = EditorInterface.save_scene() == OK
	return result


func _load_script(value):
	if typeof(value) != TYPE_STRING:
		return null
	var script_path := str(value)
	if not _is_res_path(script_path) or not script_path.ends_with(".gd"):
		return null
	var resource = load(script_path)
	return resource if resource is Script else null


func _property_info(node: Node, property: String) -> Dictionary:
	for prop in node.get_property_list():
		if str(prop["name"]) == property:
			return prop
	return {}


func _coerce(prop_type: int, value):
	match prop_type:
		TYPE_BOOL:
			return value if typeof(value) == TYPE_BOOL else null
		TYPE_INT:
			return int(value) if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT else null
		TYPE_FLOAT:
			return float(value) if typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT else null
		TYPE_STRING:
			return value if typeof(value) == TYPE_STRING else null
		TYPE_STRING_NAME:
			return StringName(value) if typeof(value) == TYPE_STRING else null
		TYPE_NODE_PATH:
			return NodePath(value) if typeof(value) == TYPE_STRING else null
		TYPE_VECTOR2, TYPE_VECTOR2I:
			if not _has_numbers(value, ["x", "y"]):
				return null
			if prop_type == TYPE_VECTOR2I:
				return Vector2i(int(value["x"]), int(value["y"]))
			return Vector2(value["x"], value["y"])
		TYPE_VECTOR3, TYPE_VECTOR3I:
			if not _has_numbers(value, ["x", "y", "z"]):
				return null
			if prop_type == TYPE_VECTOR3I:
				return Vector3i(int(value["x"]), int(value["y"]), int(value["z"]))
			return Vector3(value["x"], value["y"], value["z"])
		TYPE_COLOR:
			if typeof(value) == TYPE_STRING:
				var parsed := Color.from_string(value, Color(-1, -1, -1, -1))
				return null if parsed == Color(-1, -1, -1, -1) else parsed
			if not _has_numbers(value, ["r", "g", "b"]):
				return null
			var alpha = value.get("a", 1.0)
			return Color(value["r"], value["g"], value["b"], alpha if typeof(alpha) == TYPE_FLOAT or typeof(alpha) == TYPE_INT else 1.0)
	return null


func _has_numbers(value, keys: Array) -> bool:
	if typeof(value) != TYPE_DICTIONARY:
		return false
	for key in keys:
		if not value.has(key) or (typeof(value[key]) != TYPE_FLOAT and typeof(value[key]) != TYPE_INT):
			return false
	return true


func _screenshot(view: String) -> Dictionary:
	if view != "2d" and view != "3d":
		return {"error": "view must be 2d or 3d"}
	if DisplayServer.get_name() == "headless":
		return {"error": "the editor runs headless, there is no viewport to capture"}
	if DisplayServer.window_get_mode() == DisplayServer.WINDOW_MODE_MINIMIZED:
		return {"error": "the Godot editor window is minimized, restore it and try again"}
	var viewport: Viewport = EditorInterface.get_editor_viewport_3d(0) if view == "3d" else EditorInterface.get_editor_viewport_2d()
	if viewport == null:
		return {"error": "the %s viewport is not available" % view}
	var container = viewport.get_parent()
	if container is Control and not container.is_visible_in_tree():
		EditorInterface.set_main_screen_editor("3D" if view == "3d" else "2D")
		var alive: bool = await _wait_frames(3)
		if not alive:
			return {"error": "the addon was disabled during the screenshot"}
	var texture := viewport.get_texture()
	if texture == null:
		return {"error": "the %s viewport has no texture" % view}
	var image := texture.get_image()
	if image == null or image.is_empty():
		return {"error": "the %s viewport image is empty" % view}
	if image.get_width() > SCREENSHOT_WIDTH:
		var height := maxi(1, int(image.get_height() * float(SCREENSHOT_WIDTH) / image.get_width()))
		image.resize(SCREENSHOT_WIDTH, height, Image.INTERPOLATE_BILINEAR)
	var bytes := image.save_png_to_buffer()
	var extension := "png"
	if bytes.size() > MAX_PNG_BYTES:
		image.convert(Image.FORMAT_RGB8)
		bytes = image.save_jpg_to_buffer(0.85)
		extension = "jpg"
	var destination := ProjectSettings.globalize_path("res://.claude-godot/viewport.%s" % extension)
	DirAccess.make_dir_recursive_absolute(destination.get_base_dir())
	var file := FileAccess.open(destination, FileAccess.WRITE)
	if file == null:
		return {"error": "could not write %s" % destination}
	file.store_buffer(bytes)
	file.close()
	return {"view": view, "width": image.get_width(), "height": image.get_height(), "file": destination}


func _log(max_lines: int, errors_only: bool) -> Dictionary:
	var log_path := ProjectSettings.globalize_path(LOG_PATH)
	var result := {"playing": EditorInterface.is_playing_scene(), "file": log_path}
	if not FileAccess.file_exists(log_path):
		result["lines"] = []
		result["note"] = "No game log yet. Play the scene once. File logging must stay on: debug/file_logging/enable_file_logging."
		return result
	result["age_seconds"] = maxi(0, int(Time.get_unix_time_from_system()) - FileAccess.get_modified_time(log_path))
	var rows := _tail_lines(log_path)
	if errors_only:
		rows = _error_rows(rows)
	result["lines"] = Array(rows.slice(maxi(0, rows.size() - max_lines)))
	return result


func _tail_lines(log_path: String) -> PackedStringArray:
	var file := FileAccess.open(log_path, FileAccess.READ)
	if file == null:
		return PackedStringArray()
	var length := file.get_length()
	var start := maxi(0, length - LOG_TAIL_BYTES)
	file.seek(start)
	var buffer := file.get_buffer(length - start)
	if start > 0:
		var newline := buffer.find(10)
		buffer = buffer.slice(newline + 1) if newline >= 0 else PackedByteArray()
	var rows := buffer.get_string_from_utf8().replace("\r", "").split("\n", false)
	for index in rows.size():
		if rows[index].length() > MAX_TEXT:
			rows[index] = rows[index].substr(0, MAX_TEXT) + "..."
	return rows


func _error_rows(rows: PackedStringArray) -> PackedStringArray:
	var output := PackedStringArray()
	var keep := false
	for row in rows:
		if _is_error_row(row):
			keep = true
			output.append(row)
		elif keep and (row.begins_with(" ") or row.begins_with("\t")):
			output.append(row)
		else:
			keep = false
	return output


func _is_error_row(row: String) -> bool:
	for prefix in ERROR_PREFIXES:
		if row.begins_with(prefix + ":"):
			return true
	return false


func _play(action: String) -> Dictionary:
	match action:
		"play":
			EditorInterface.play_current_scene()
		"main":
			EditorInterface.play_main_scene()
		"stop":
			EditorInterface.stop_playing_scene()
		_:
			return {"error": "action must be play, main, or stop"}
	var alive: bool = await _wait_frames(2)
	if not alive:
		return {"error": "the addon was disabled while starting play"}
	return {"action": action, "playing": EditorInterface.is_playing_scene()}


func _refresh(scene_path: String) -> Dictionary:
	if scene_path != "" and not _is_res_path(scene_path):
		return {"error": "scene must be a res:// path with forward slashes"}
	var filesystem := EditorInterface.get_resource_filesystem()
	if not filesystem.is_scanning():
		filesystem.scan()
	var deadline := Time.get_ticks_msec() + SCAN_TIMEOUT_MS
	while filesystem.is_scanning() and Time.get_ticks_msec() < deadline:
		var alive: bool = await _wait_frames(1)
		if not alive:
			return {"error": "the addon was disabled during the scan"}
	var result := {"scanning": filesystem.is_scanning()}
	if scene_path != "":
		if not FileAccess.file_exists(scene_path):
			return {"error": "no file at %s" % scene_path}
		if scene_path in EditorInterface.get_open_scenes():
			EditorInterface.reload_scene_from_path(scene_path)
			result["reloaded"] = scene_path
		EditorInterface.open_scene_from_path(scene_path)
	var root := EditorInterface.get_edited_scene_root()
	result["scene"] = root.scene_file_path if root else ""
	return result


func _wait_frames(count: int) -> bool:
	for index in count:
		if not is_inside_tree():
			return false
		await get_tree().process_frame
	return is_inside_tree()


func _is_res_path(resource_path: String) -> bool:
	return resource_path.begins_with("res://") and not ".." in resource_path and not "\\" in resource_path


func _is_property_name(property: String) -> bool:
	if property.is_empty() or property.length() > 80:
		return false
	for index in property.length():
		var code := property.unicode_at(index)
		var letter := (code >= 65 and code <= 90) or (code >= 97 and code <= 122) or code == 95
		var tail := index > 0 and ((code >= 48 and code <= 57) or code == 47)
		if not letter and not tail:
			return false
	return true


func _resolve(node_path: String) -> Node:
	var root := EditorInterface.get_edited_scene_root()
	if root == null:
		return null
	if node_path == "" or node_path == ".":
		return root
	if node_path.begins_with("/") or "\\" in node_path or "." in node_path or ":" in node_path:
		return null
	return root.get_node_or_null(NodePath(node_path))
